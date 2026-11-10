package main

import (
	"context"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow"
)

type MediaDownloader struct {
	URL, DirectPath                     string
	MediaKey, FileSHA256, FileEncSHA256 []byte
	FileLength                          uint64
	MediaType                           whatsmeow.MediaType
}

func (d *MediaDownloader) GetURL() string                    { return d.URL }
func (d *MediaDownloader) GetDirectPath() string             { return d.DirectPath }
func (d *MediaDownloader) GetMediaKey() []byte               { return d.MediaKey }
func (d *MediaDownloader) GetFileSHA256() []byte             { return d.FileSHA256 }
func (d *MediaDownloader) GetFileEncSHA256() []byte          { return d.FileEncSHA256 }
func (d *MediaDownloader) GetFileLength() uint64             { return d.FileLength }
func (d *MediaDownloader) GetMediaType() whatsmeow.MediaType { return d.MediaType }

func (w *worker) sendMedia(ctx context.Context, client *whatsmeow.Client, args map[string]string, voice bool, messageID string) map[string]any {
	id, err := uuid.Parse(args["file_id"])
	if err != nil || id.String() != args["file_id"] {
		return failure("invalid_file_id")
	}
	var filename string
	var size int64
	err = w.db.QueryRowContext(ctx, "SELECT filename,size_bytes FROM assets WHERE id=?", id.String()).Scan(&filename, &size)
	if err != nil || size > maxFileSize {
		return failure("file_not_found")
	}
	asset, err := os.OpenFile(filepath.Join(w.assets, id.String()), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return failure("file_not_found")
	}
	defer asset.Close()
	info, err := asset.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		return failure("file_changed")
	}
	dir, err := os.MkdirTemp(w.assets, ".tmp-send-")
	if err != nil {
		return failure("temporary_file_failed")
	}
	defer os.RemoveAll(dir)
	ext := strings.ToLower(filepath.Ext(filename))
	if len(ext) > 10 {
		ext = ""
	}
	local := filepath.Join(dir, "attachment"+ext)
	dest, err := os.OpenFile(local, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return failure("temporary_file_failed")
	}
	copied, err := io.Copy(dest, io.LimitReader(asset, maxFileSize+1))
	closeErr := dest.Close()
	if err != nil || closeErr != nil || copied != size {
		return failure("file_changed")
	}

	if voice {
		data, err := os.ReadFile(local)
		if err != nil {
			return failure("file_not_found")
		}
		voicePath := filepath.Join(dir, "voice.ogg")
		if _, _, err := analyzeOggOpus(data); err == nil {
			if err := os.Rename(local, voicePath); err != nil {
				return failure("temporary_file_failed")
			}
		} else {
			if w.ffmpeg == "" {
				result := failure("ffmpeg_required")
				result["message"] = "Use an Ogg Opus file or install FFmpeg and rerun ./setup."
				return result
			}
			input, err := os.Open(local)
			if err != nil {
				return failure("file_not_found")
			}
			defer input.Close()
			cmd := exec.CommandContext(ctx, w.ffmpeg, "-nostdin", "-v", "error",
				"-protocol_whitelist", "pipe", "-i", "pipe:0", "-vn", "-c:a", "libopus", "-fs", "20971521", voicePath)
			cmd.Stdin = input
			if err := cmd.Run(); err != nil {
				return failure("audio_conversion_failed")
			}
			if info, err := os.Stat(voicePath); err != nil || info.Size() > maxFileSize {
				return failure("converted_audio_too_large")
			}
		}
		local = voicePath
	}
	ok, _ := sendWhatsAppMessage(ctx, client, args["recipient"], "", local, messageID, filename)
	if !ok {
		return map[string]any{"status": "unknown", "message": "Media delivery was not confirmed. Check the chat before retrying."}
	}
	return map[string]any{"status": "succeeded", "message": "Media sent"}
}

func (w *worker) download(ctx context.Context, client *whatsmeow.Client, args map[string]string) map[string]any {
	var kind, filename, remote, directPath string
	var key, sha, encSha []byte
	var size int64
	err := w.db.QueryRowContext(ctx, `SELECT media_type,filename,url,direct_path,media_key,file_sha256,file_enc_sha256,file_length
		FROM messages WHERE id=? AND chat_jid=?`, args["message_id"], args["chat_jid"]).Scan(&kind, &filename, &remote, &directPath, &key, &sha, &encSha, &size)
	if err != nil || size <= 0 || size > maxFileSize {
		return failure("media_missing_or_too_large")
	}
	if directPath == "" {
		u, err := url.Parse(remote)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return failure("invalid_media")
		}
		directPath = u.RequestURI()
	}
	if !strings.HasPrefix(directPath, "/") || strings.HasPrefix(directPath, "//") {
		return failure("invalid_media")
	}
	media := whatsmeow.MediaDocument
	switch kind {
	case "image":
		media = whatsmeow.MediaImage
	case "video":
		media = whatsmeow.MediaVideo
	case "audio":
		media = whatsmeow.MediaAudio
	}
	temporary, err := os.CreateTemp(w.assets, ".tmp-download-")
	if err != nil {
		return failure("temporary_file_failed")
	}
	defer os.Remove(temporary.Name())
	defer temporary.Close()
	bounded := &boundedMediaFile{File: temporary, limit: maxFileSize + 32}
	err = client.DownloadToFile(ctx, &MediaDownloader{URL: remote, DirectPath: directPath, MediaKey: key, FileSHA256: sha, FileEncSHA256: encSha, FileLength: uint64(size), MediaType: media}, bounded)
	if err != nil {
		return failure("media_download_failed")
	}
	info, err := temporary.Stat()
	if err != nil || info.Size() > maxFileSize {
		return failure("media_missing_or_too_large")
	}

	id := uuid.NewString()
	path := filepath.Join(w.assets, id)
	if err = temporary.Sync(); err != nil {
		return failure("media_store_failed")
	}
	if err = os.Rename(temporary.Name(), path); err != nil {
		return failure("media_store_failed")
	}
	filename = displayName(filename)
	_, err = w.db.ExecContext(ctx, `INSERT INTO assets(id,filename,source,content_type,size_bytes,created_at_ms)
		VALUES(?,?,'whatsapp','application/octet-stream',?,?)`, id, filename, info.Size(), time.Now().UnixMilli())
	if err != nil {
		_ = os.Remove(path)
		return failure("media_record_failed")
	}
	return map[string]any{"status": "succeeded", "file_id": id, "filename": filename}
}

func displayName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name))
	if name == "" || name == "." || name == "/" {
		return "attachment"
	}
	runes := []rune(name)
	if len(runes) > 200 {
		return string(runes[:200])
	}
	return name
}

// Bound encrypted input as well as decrypted output; message size metadata is untrusted.
type boundedMediaFile struct {
	*os.File
	limit int64
}

func (f *boundedMediaFile) Write(p []byte) (int, error) {
	offset, err := f.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	if offset < 0 || offset > f.limit || int64(len(p)) > f.limit-offset {
		return 0, errors.New("media exceeds size limit")
	}
	return f.File.Write(p)
}
func (f *boundedMediaFile) WriteAt(p []byte, offset int64) (int, error) {
	if offset < 0 || offset > f.limit || int64(len(p)) > f.limit-offset {
		return 0, errors.New("media exceeds size limit")
	}
	return f.File.WriteAt(p, offset)
}
func (f *boundedMediaFile) Truncate(size int64) error {
	if size < 0 || size > f.limit {
		return errors.New("media exceeds size limit")
	}
	return f.File.Truncate(size)
}
func (f *boundedMediaFile) ReadFrom(r io.Reader) (int64, error) {
	return io.Copy(struct{ io.Writer }{f}, r)
}
