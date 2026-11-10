package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func TestFreshSQLiteSession(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "WhatsApp Store.sqlite3")
	db, err := openDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	store := sqlstore.NewWithDB(db, "sqlite3", waLog.Noop)
	defer store.Close()
	if err := store.Upgrade(ctx); err != nil {
		t.Fatal(err)
	}
	device, err := store.GetFirstDevice(ctx)
	if err != nil || device == nil || device.ID != nil {
		t.Fatalf("expected a fresh unlinked device, got error %v", err)
	}
}

func TestBoundedMedia(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "download-")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	bounded := &boundedMediaFile{File: file, limit: 3}
	if _, err := bounded.Write([]byte("abc")); err != nil {
		t.Fatal(err)
	}
	if _, err := bounded.Write([]byte("d")); err == nil {
		t.Fatal("accepted an over-limit write")
	}
	if _, err := bounded.WriteAt([]byte("bc"), 2); err == nil {
		t.Fatal("accepted an over-limit positional write")
	}
	if _, err := bounded.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if err := bounded.Truncate(4); err == nil {
		t.Fatal("accepted an over-limit truncate")
	}
}
