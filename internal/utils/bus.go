package utils

import "github.com/asaskevich/EventBus"

var Bus = EventBus.New()

const (
	STARTED       = "started"
	RECV_MSG      = "receive_message"
	SEND_MSG      = "send_message"
	LABEL_EMOJI   = "label_emoji"
	LABELED_EMOJI = "labeled_emoji"
	STOPPED       = "stopped"
)
