package idle

import (
	"encoding/json"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/utils"
	"os"
	path2 "path"
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
		dir := path2.Join("data", "idle")
		err := os.MkdirAll(dir, 0755)
		if err != nil {
			log.Logger.Errorf("创建 idle 数据目录失败: %v", err)
			return
		}
		db := utils.New("emoji", dir, 65535*100, 0, 65535, 2500, 2*time.Second, nil)
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
		utils.Bus.Publish(utils.LabelEmoji, emojiMsg.Id, image, "emoji")
	}
}

// Wandering 处理器，结合闲时处理任务（相关时）为 bot 生成当前手头正在进行的工作
