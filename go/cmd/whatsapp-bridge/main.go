package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	_ "modernc.org/sqlite"
)

const maxFileSize = 20 * 1024 * 1024

type worker struct {
	db        *sql.DB
	keys      *sqlstore.Container
	ctx       context.Context
	assets    string
	ffmpeg    string
	client    atomic.Pointer[whatsmeow.Client]
	draining  atomic.Bool
	loggedOut atomic.Bool
	mu        sync.Mutex
	pairing   bool
	outputMu  sync.Mutex
	state     string
	output    *json.Encoder
}

func openDB(ctx context.Context, path string) (*sql.DB, error) {
	u := url.URL{Scheme: "file", Path: path}
	query := url.Values{"_pragma": {"foreign_keys(1)", "busy_timeout(3000)", "synchronous(FULL)"}}
	u.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func main() {
	data := flag.String("data-dir", "", "Installed app data directory")
	ffmpeg := flag.String("ffmpeg", "", "Absolute path to FFmpeg")
	flag.Parse()
	if !filepath.IsAbs(*data) {
		log.Fatal("bridge requires an absolute data directory")
	}
	syscall.Umask(0077)
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, *data, *ffmpeg); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("bridge stopped: %v", err)
	}
}

func run(parent context.Context, data, ffmpeg string) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	db, err := openDB(ctx, filepath.Join(data, "db", "app.sqlite3"))
	if err != nil {
		return errors.New("could not open app database")
	}
	defer db.Close()
	keysDB, err := openDB(ctx, filepath.Join(data, "db", "whatsapp.sqlite3"))
	if err != nil {
		return errors.New("could not open WhatsApp session database")
	}
	keys := sqlstore.NewWithDB(keysDB, "sqlite3", waLog.Noop)
	defer keys.Close()
	if err = keys.Upgrade(ctx); err != nil {
		return errors.New("could not migrate WhatsApp session database")
	}
	device, err := keys.GetFirstDevice(ctx)
	if err != nil {
		return errors.New("could not read WhatsApp device")
	}

	w := &worker{db: db, keys: keys, ctx: ctx, assets: filepath.Join(data, "assets"), ffmpeg: ffmpeg, output: json.NewEncoder(os.Stdout)}
	client := whatsmeow.NewClient(device, waLog.Noop)
	w.setClient(client)
	defer func() { w.client.Load().Disconnect() }()
	if _, err = db.ExecContext(ctx, `UPDATE commands
		SET status = CASE status WHEN 'running' THEN 'unknown' ELSE 'expired' END,
		    completed_at_ms = ?, result_json = NULL
		WHERE status IN ('pending','running')`, time.Now().UnixMilli()); err != nil {
		return errors.New("could not reconcile interrupted operations")
	}
	if device.ID == nil {
		w.setState("pairing_required")
	} else {
		w.setState("connecting")
		go w.reconnect(client)
	}

	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			var request struct{ Type string }
			if json.Unmarshal(scanner.Bytes(), &request) != nil {
				continue
			}
			switch request.Type {
			case "pair":
				if !w.draining.Load() {
					w.requestPairing()
				}
			case "drain":
				w.draining.Store(true)
			}
		}
		cancel()
	}()

	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for ctx.Err() == nil {
		if w.draining.Load() {
			w.emit(map[string]any{"type": "drained"})
			return nil
		}
		found, err := w.process()
		if err != nil {
			return errors.New("could not process the operation queue")
		}
		if !found {
			select {
			case <-ctx.Done():
			case <-ticker.C:
			}
		}
	}
	return ctx.Err()
}

func (w *worker) emit(message map[string]any) {
	w.outputMu.Lock()
	defer w.outputMu.Unlock()
	_ = w.output.Encode(message)
}

func (w *worker) setState(state string) {
	w.outputMu.Lock()
	defer w.outputMu.Unlock()
	if w.state != state {
		w.state = state
		_ = w.output.Encode(map[string]any{"type": "state", "state": state})
	}
}

func (w *worker) setClient(client *whatsmeow.Client) {
	client.AddEventHandler(func(event any) { w.event(client, event) })
	w.client.Store(client)
}

func (w *worker) reconnect(client *whatsmeow.Client) {
	for delay := time.Second; w.ctx.Err() == nil && !w.draining.Load(); {
		if w.client.Load() != client || w.loggedOut.Load() {
			return
		}
		if client.IsConnected() || client.ConnectContext(w.ctx) == nil {
			return
		}
		w.setState("offline")
		select {
		case <-w.ctx.Done():
			return
		case <-time.After(delay):
		}
		if delay < 16*time.Second {
			delay *= 2
		}
	}
}

func (w *worker) requestPairing() {
	w.mu.Lock()
	if w.pairing || w.client.Load().IsLoggedIn() {
		w.mu.Unlock()
		return
	}
	w.pairing = true
	w.mu.Unlock()

	go func() {
		defer func() { w.mu.Lock(); w.pairing = false; w.mu.Unlock() }()
		device, err := w.keys.GetFirstDevice(w.ctx)
		if err != nil {
			w.setState("pairing_required")
			return
		}
		if device.ID != nil {
			// A saved device may be temporarily offline. Leave its reconnect loop running.
			return
		}
		oldClient := w.client.Load()
		client := whatsmeow.NewClient(device, waLog.Noop)
		w.setClient(client)
		oldClient.Disconnect()
		w.loggedOut.Store(false)

		ctx, cancel := context.WithCancel(w.ctx)
		defer cancel()
		qr, err := client.GetQRChannel(ctx)
		if err != nil {
			w.setState("pairing_required")
			return
		}
		w.setState("pairing")
		if err = client.ConnectContext(ctx); err != nil {
			w.setState("pairing_required")
			return
		}
		for event := range qr {
			switch event.Event {
			case "code":
				w.emit(map[string]any{"type": "qr", "code": event.Code, "expiresAtMs": time.Now().Add(event.Timeout).UnixMilli()})
			case "success":
				return // The connected event confirms readiness.
			default:
				w.setState("pairing_required")
			}
		}
		if !client.IsLoggedIn() {
			w.setState("pairing_required")
		}
	}()
}

func failure(code string) map[string]any { return map[string]any{"status": "failed", "error": code} }

func (w *worker) process() (bool, error) {
	now := time.Now().UnixMilli()
	if _, err := w.db.ExecContext(w.ctx, `UPDATE commands SET status='expired', completed_at_ms=?
		WHERE status='pending' AND expires_at_ms<=?`, now, now); err != nil {
		return false, err
	}
	var id, kind, payload string
	err := w.db.QueryRowContext(w.ctx, `UPDATE commands SET status='running', started_at_ms=?
		WHERE id=(SELECT id FROM commands WHERE status='pending' AND expires_at_ms>?
			ORDER BY created_at_ms, id LIMIT 1)
		RETURNING id,kind,payload_json`, now, now).Scan(&id, &kind, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var args map[string]string
	result := failure("invalid_payload")
	if json.Unmarshal([]byte(payload), &args) == nil {
		result = w.execute(id, kind, args)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return false, err
	}
	// Record a known result even if shutdown began after the external effect.
	recordCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err = w.db.ExecContext(recordCtx, `UPDATE commands SET status=?,result_json=?,completed_at_ms=? WHERE id=?`,
		result["status"], string(encoded), time.Now().UnixMilli(), id)
	return true, err
}

func (w *worker) execute(id, kind string, args map[string]string) map[string]any {
	client := w.client.Load()
	if !client.IsConnected() || !client.IsLoggedIn() {
		result := failure("whatsapp_offline")
		result["reconnect_url"] = "http://localhost:7865/"
		return result
	}
	ctx, cancel := context.WithTimeout(w.ctx, 90*time.Second)
	defer cancel()
	switch kind {
	case "send":
		jid, err := types.ParseJID(args["recipient"])
		if err != nil {
			return failure("invalid_recipient")
		}
		message := args["message"]
		_, err = client.SendMessage(ctx, jid, &waProto.Message{Conversation: &message}, whatsmeow.SendRequestExtra{ID: id})
		if err != nil {
			return map[string]any{"status": "unknown", "message": "Delivery was not confirmed. Check the chat before retrying."}
		}
		return map[string]any{"status": "succeeded", "message": "Message sent"}
	case "send_file", "send_audio":
		return w.sendMedia(ctx, client, args, kind == "send_audio", id)
	case "download":
		return w.download(ctx, client, args)
	default:
		return failure("unsupported_command")
	}
}

func (w *worker) event(client *whatsmeow.Client, evt any) {
	if w.client.Load() != client {
		return
	}
	switch e := evt.(type) {
	case *events.Connected:
		w.setState("connected")
		go w.syncContacts(client)
	case *events.Disconnected:
		if w.loggedOut.Load() {
			w.setState("pairing_required")
		} else {
			if client.Store.ID != nil {
				w.setState("offline")
			}
		}
	case *events.LoggedOut:
		w.loggedOut.Store(true)
		w.setState("pairing_required")
	case *events.Message:
		w.storeMessage(e.Info.ID, e.Info.Chat.String(), e.Info.Sender.String(), e.Info.Timestamp, e.Info.IsFromMe, e.Message, "")
	case *events.HistorySync:
		for _, chat := range e.Data.Conversations {
			if chat.ID == nil {
				continue
			}
			name := chat.GetName()
			if name == "" {
				name = chat.GetDisplayName()
			}
			for _, item := range chat.Messages {
				if item.Message == nil || item.Message.Key == nil || item.Message.Message == nil {
					continue
				}
				m := item.Message
				sender := m.Key.GetParticipant()
				if sender == "" {
					sender = *chat.ID
				}
				if m.Key.GetFromMe() && client.Store.ID != nil {
					sender = client.Store.ID.String()
				}
				w.storeMessage(m.Key.GetID(), *chat.ID, sender, time.Unix(int64(m.GetMessageTimestamp()), 0), m.Key.GetFromMe(), m.Message, name)
			}
		}
		go w.syncContacts(client)
	}
}
func (w *worker) storeMessage(id, jid, sender string, at time.Time, fromMe bool, msg *waProto.Message, name string) {
	if id == "" || msg == nil {
		return
	}
	text := extractTextContent(msg)
	kind, filename, url, directPath, key, sha, encSha, length := extractMediaInfo(msg)
	if text == "" && kind == "" {
		return
	}
	ctx, cancel := context.WithTimeout(w.ctx, 10*time.Second)
	defer cancel()
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO chats(jid,name,last_message_time) VALUES(?,?,?) ON CONFLICT(jid) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE chats.name END,last_message_time=MAX(chats.last_message_time,excluded.last_message_time)`, jid, name, at.UnixMilli())
	if err != nil {
		return
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO messages(id,chat_jid,sender,content,timestamp,is_from_me,media_type,filename,url,direct_path,media_key,file_sha256,file_enc_sha256,file_length) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id,chat_jid) DO NOTHING`, id, jid, sender, text, at.UnixMilli(), fromMe, kind, filename, url, directPath, key, sha, encSha, int64(length))
	if err == nil {
		_ = tx.Commit()
	}
}
func (w *worker) syncContacts(client *whatsmeow.Client) {
	ctx, cancel := context.WithTimeout(w.ctx, 30*time.Second)
	defer cancel()
	contacts, err := client.Store.Contacts.GetAllContacts(ctx)
	if err != nil {
		return
	}
	for jid, c := range contacts {
		_, _ = w.db.ExecContext(ctx, `INSERT INTO contacts(jid,name,push_name) VALUES(?,?,?) ON CONFLICT(jid) DO UPDATE SET name=excluded.name,push_name=excluded.push_name`, jid.String(), c.FullName, c.PushName)
	}
}
