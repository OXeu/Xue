package idle

import (
	"github.com/OXeu/Xue/internal/face"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/utils"
	"github.com/robfig/cron/v3"
	"os"
	path2 "path"
	"sync"
)

// Handler 闲时处理器，队列内容需要持久化
type Handler struct {
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
		instance = &Handler{}
	})
	return instance
}

func (h *Handler) Start() {
	// 每 5 分钟扫描未标记的表情包
	c := cron.New(cron.WithSeconds())
	_, err := c.AddFunc("0 0/5 * * * *", func() {
		unlabeledEmojis := face.GetFaceManager().GetUnlabeledFaces()
		log.Logger.Infof("[Idle] 扫描 %d 个未标记的表情包", len(unlabeledEmojis))
		for _, emojiMsg := range unlabeledEmojis {
			image, err := emojiMsg.GetImage()
			if err != nil {
				continue
			}
			utils.Bus.Publish(utils.LabelEmoji, emojiMsg.Id, image, "emoji")
		}
	})
	c.Start()
	if err != nil {
		log.Logger.Error("[Idle]", "add cron job failed: ", err)
	}
}

// Wandering 处理器，结合闲时处理任务（相关时）为 bot 生成当前手头正在进行的工作
