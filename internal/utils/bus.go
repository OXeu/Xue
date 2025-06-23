package utils

import (
	"github.com/danielhookx/eventbus"
)

var Bus = eventbus.New()

const (
	Started       = "started"
	PreReceiveMsg = "pre_receive_message"
	ReceiveMsg    = "receive_message"
	ClearHistory  = "clear_history"
	PreSendMsg    = "pre_send_message"
	SendMsg       = "send_message"
	SentMsg       = "sent_message"
	ReplyMsg      = "reply_message"
	LabelEmoji    = "label_emoji"
	LabeledEmoji  = "labeled_emoji"
	Stopped       = "stopped"
	ReceiveEmoji  = "receive_emoji"
	PlanChanged   = "plan_changed"
)
