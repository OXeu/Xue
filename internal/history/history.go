package history

import (
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/message/protocol"
	"github.com/OXeu/Xue/internal/utils"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"sync"
	"time"
)

const Limit = 10

// History 历史记录管理器 存储历史消息，在模型处理时返回最新 N 条消息以及回复链消息
type History struct {
	Db *gorm.DB
}

var (
	history     *History
	historyOnce sync.Once
)

func GetHistory() *History {
	historyOnce.Do(func() {
		db, err := gorm.Open(sqlite.Open("data/history.db"), &gorm.Config{})
		if err != nil {
			if err != nil {
				log.Logger.Errorln("[history] failed to connect database:", err)
			}
		}
		err = db.AutoMigrate(&element.Message{})
		if err != nil {
			log.Logger.Errorln("[history] failed to migrate:", err)
		}
		history = &History{
			Db: db,
		}
	})
	return history
}

func (h *History) Start() {
	go func() {
		err := utils.Bus.Subscribe(utils.ReceiveMsg, h.write)
		if err != nil {
			log.Logger.Errorln("[history] subscribe recv msg error:", err)
			return
		}
	}()
	go func() {
		err := utils.Bus.Subscribe(utils.SendMsg, h.writeSendMessage)
		if err != nil {
			log.Logger.Errorln("[history] subscribe recv msg error:", err)
			return
		}
	}()
}

func (h *History) writeSendMessage(message *element.SendMessage) {
	var content string
	for _, ele := range *message.Element {
		content += ele.ToReadableString() + ";"
	}
	uin := protocol.GetLagrange().QqClient.Uin
	msg := element.Message{
		UID:       uin,
		SessionId: message.TargetId,
		IsPrivate: message.IsPrivate,
		Content:   content,
		Time:      uint32(time.Now().Unix()),
	}
	h.write(&msg)
}

func (h *History) write(message *element.Message) {
	h.Db.Create(message)
	log.Logger.Infoln("[history] write message:", message.ReadableContent())
}

// RecallHistory 召回历史消息（包含最新消息的回复链）
func (h *History) RecallHistory(sessionId uint32, isPrivate bool, replyId uint32) []element.Message {
	if replyId == 0 {
		return h.ReadLatest(sessionId, isPrivate)
	}
	return MergeMessages(h.ReadLatest(sessionId, isPrivate), h.ReadReplyChian(sessionId, isPrivate, replyId))
}

func (h *History) ReadLatest(sessionId uint32, isPrivate bool) []element.Message {
	var historyItems []element.Message
	h.Db.Where(&element.Message{SessionId: sessionId, IsPrivate: isPrivate}).Limit(Limit).Find(&historyItems)
	return historyItems
}

func (h *History) ReadReplyChian(targetId uint32, isPrivate bool, replyId uint32) []element.Message {
	var historyItems []element.Message
	msgId := replyId
	for {
		if msgId == 0 {
			break
		}
		var historyItem element.Message
		h.Db.Where(&element.Message{MsgId: msgId, SessionId: targetId, IsPrivate: isPrivate}).First(&historyItem)
		if historyItem.MsgId == msgId {
			historyItems = append(historyItems, historyItem)
			if historyItem.ReplyTo != 0 {
				msgId = historyItem.ReplyTo
			} else {
				break
			}
		} else {
			break
		}
	}
	return historyItems
}

func (h *History) RecallReply(targetId uint32, isPrivate bool, replyId uint32) *element.Message {
	msgId := replyId
	if msgId == 0 {
		return nil
	}
	var historyItem element.Message
	h.Db.Where(&element.Message{MsgId: msgId, SessionId: targetId, IsPrivate: isPrivate}).First(&historyItem)
	if historyItem.MsgId == msgId {
		return &historyItem
	}
	return nil
}

func MergeMessages(messages ...[]element.Message) []element.Message {
	var mergedMessages []element.Message
	// 去重
	for _, msg := range messages {
		for _, m := range msg {
			if m.MsgId == 0 {
				continue
			}
			found := false
			for _, mm := range mergedMessages {
				if mm.MsgId == m.MsgId {
					found = true
					break
				}
			}
			if !found {
				mergedMessages = append(mergedMessages, m)
			}
		}
	}
	return mergedMessages
}
