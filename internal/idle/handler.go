package idle

import (
	"encoding/json"
	"github.com/OXeu/xue/internal/message/element"
	"github.com/OXeu/xue/internal/utils"
	"sync"
	"time"
)

// Handler 闲时处理器，队列内容需要持久化
type Handler struct {
	EmojiQueue utils.Interface
}

var (
	once     sync.Once
	instance *Handler
)

func GetIdleHandler() *Handler {
	once.Do(func() {
		db := utils.New("emoji", "data/idle.queue.txt", 65535*100, 0, 65535, 2500, 2*time.Second, nil)
		instance = &Handler{
			EmojiQueue: db,
		}
	})
	return instance
}

func (h *Handler) Start() {
	emojiQueue := h.EmojiQueue.ReadChan()
	for emoji := range emojiQueue {
		emojiMsg := element.CustomFaceElement{}
		err := json.Unmarshal(emoji, &emojiMsg)
		if err != nil {
			continue
		}
		image, err := emojiMsg.GetImage()
		if err != nil {
			continue
		}
		utils.Bus.Publish("label", emojiMsg.Id, image, "emoji")
	}
}

// Wandering 处理器，结合闲时处理任务（相关时）为 bot 生成当前手头正在进行的工作
