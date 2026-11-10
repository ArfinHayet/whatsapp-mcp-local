package main

import (
	"context"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
)

type testPairingClient struct {
	events        chan whatsmeow.QRChannelItem
	qrContext     context.Context
	socketContext context.Context
}

func (c *testPairingClient) GetQRChannel(ctx context.Context) (<-chan whatsmeow.QRChannelItem, error) {
	c.qrContext = ctx
	return c.events, nil
}

func (c *testPairingClient) ConnectContext(ctx context.Context) error {
	c.socketContext = ctx
	return nil
}

func TestPairingSuccessKeepsSocketContextAlive(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	client := &testPairingClient{events: make(chan whatsmeow.QRChannelItem, 2)}
	client.events <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "test", Timeout: time.Minute}
	client.events <- whatsmeow.QRChannelSuccess
	close(client.events)

	started, displayed := false, false
	outcome := pairWithQR(ctx, client, func() { started = true }, func(item whatsmeow.QRChannelItem) {
		displayed = item.Code == "test"
	})
	if outcome != "" || !started || !displayed {
		t.Fatalf("pairing outcome=%q started=%t displayed=%t", outcome, started, displayed)
	}
	if client.qrContext.Err() != context.Canceled {
		t.Fatal("the QR context should close after the scan")
	}
	if err := client.socketContext.Err(); err != nil {
		t.Fatalf("the post-pairing reconnect must remain possible: %v", err)
	}
	stop()
	if client.socketContext.Err() != context.Canceled {
		t.Fatal("bridge shutdown should cancel the connection context")
	}
}

func TestExpiredQRIsReported(t *testing.T) {
	client := &testPairingClient{events: make(chan whatsmeow.QRChannelItem, 1)}
	client.events <- whatsmeow.QRChannelTimeout
	close(client.events)
	outcome := pairWithQR(context.Background(), client, func() {}, func(whatsmeow.QRChannelItem) {
		t.Fatal("an expired event should not display a QR")
	})
	if outcome != "qr_expired" {
		t.Fatalf("pairing outcome=%q, want qr_expired", outcome)
	}
}
