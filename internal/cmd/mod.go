package cmd

import (
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/utils"
	"strings"
	"sync"
)

type Handler struct {
}

var (
	handler *Handler
	once    sync.Once
)

func GetHandler() *Handler {
	once.Do(func() {
		handler = &Handler{}
	})
	return handler
}

func (h *Handler) Start() {
	err := utils.Bus.Subscribe(utils.ReceiveMsg, h.handle)
	if err != nil {
		log.Logger.Errorln("[handler] subscribe receive message failed:", err)
	}
}

func (h *Handler) handle(msg *element.Message) {
	if strings.Contains(msg.Content, "#clear") {
		utils.Bus.Publish(utils.ClearHistory, msg.SessionId, msg.IsPrivate)
	}
}
