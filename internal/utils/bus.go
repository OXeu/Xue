package utils

import (
	"github.com/danielhookx/eventbus"
)

var Bus = eventbus.New()

const (
	STARTED       = "started"
	RECV_MSG      = "receive_message"
	SEND_MSG      = "send_message"
	SENDED_MSG    = "sended_message"
	LABEL_EMOJI   = "label_emoji"
	LABELED_EMOJI = "labeled_emoji"
	STOPPED       = "stopped"
)
