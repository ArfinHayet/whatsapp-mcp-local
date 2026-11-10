package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestBootState(t *testing.T) {
	data := t.TempDir()
	if err := os.Mkdir(filepath.Join(data, "control"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, enabled := range []bool{true, false, false, true, false} {
		if err := withStateLock(data, func() error { return setEnabled(data, enabled) }); err != nil {
			t.Fatal(err)
		}
		_, err := os.Stat(marker(data))
		if enabled && err != nil {
			t.Fatalf("startup should be enabled: %v", err)
		}
		if !enabled && !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("startup should be disabled: %v", err)
		}
	}
}
