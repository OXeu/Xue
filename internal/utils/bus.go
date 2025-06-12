package utils

import (
	"github.com/danielhookx/eventbus"
)

var Bus = eventbus.New()

const (
	STARTED      = "started"
	ReceiveMsg   = "receive_message"
	PreSendMsg   = "pre_send_message"
	SendMsg      = "send_message"
	SentMsg      = "sent_message"
	ReplyMsg     = "reply_message"
	LabelEmoji   = "label_emoji"
	LabeledEmoji = "labeled_emoji"
	STOPPED      = "stopped"
	ReceiveEmoji = "receive_emoji"
	PlanChanged  = "plan_changed"
)
