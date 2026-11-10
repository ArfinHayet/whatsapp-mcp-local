package main

import (
	"context"

	"go.mau.fi/whatsmeow"
)

type qrPairingClient interface {
	GetQRChannel(context.Context) (<-chan whatsmeow.QRChannelItem, error)
	ConnectContext(context.Context) error
}

// A successful scan closes the QR stream, but WhatsApp still needs the
// connection's context to process the reconnect that authenticates the device.
func pairWithQR(ctx context.Context, client qrPairingClient, started func(), code func(whatsmeow.QRChannelItem)) string {
	qrCtx, cancelQR := context.WithCancel(ctx)
	defer cancelQR()

	events, err := client.GetQRChannel(qrCtx)
	if err != nil {
		return "qr_setup_failed"
	}
	started()
	if err := client.ConnectContext(ctx); err != nil {
		return "pair_connection_failed"
	}
	for event := range events {
		switch event.Event {
		case whatsmeow.QRChannelEventCode:
			code(event)
		case whatsmeow.QRChannelSuccess.Event:
			return ""
		case whatsmeow.QRChannelTimeout.Event:
			return "qr_expired"
		case whatsmeow.QRChannelClientOutdated.Event:
			return "client_outdated"
		default:
			return "pair_failed"
		}
	}
	return "qr_expired"
}
