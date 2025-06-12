package history

import (
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/utils"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"sync"
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
	err := utils.Bus.Subscribe(utils.RECV_MSG, h.write)
	if err != nil {
		log.Logger.Errorln("[history] subscribe recv msg error:", err)
		return
	}
}

func (h *History) write(message *element.Message) {
	h.Db.Create(message)
}

// RecallHistory 召回历史消息（包含最新消息的回复链）
func (h *History) RecallHistory(id uint32, isPrivate bool, replyId uint32) []element.Message {
	if replyId == 0 {
		return h.ReadLatest(id, isPrivate)
	}
	return MergeMessages(h.ReadLatest(id, isPrivate), h.ReadReplyChian(id, isPrivate, replyId))
}

func (h *History) ReadLatest(id uint32, isPrivate bool) []element.Message {
	var historyItems []element.Message
	if isPrivate {
		h.Db.Where("uid = ?", id).Find(&historyItems).Limit(Limit)
	} else {
		h.Db.Where("gid = ?", id).Find(&historyItems).Limit(Limit)
	}
	return historyItems
}

func (h *History) ReadReplyChian(id uint32, isPrivate bool, replyId uint32) []element.Message {
	var historyItems []element.Message
	msgId := replyId
	for {
		if msgId == 0 {
			break
		}
		var historyItem element.Message
		if isPrivate {
			h.Db.Where(&element.Message{MsgId: msgId, UID: id}).First(&historyItem)
		} else {
			h.Db.Where(&element.Message{MsgId: msgId, GID: id}).First(&historyItem)
		}
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
