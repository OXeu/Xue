package label

import (
	"github.com/OXeu/Xue/internal/llm"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/utils"
	"go.uber.org/zap"
	"sync"
)

// Handler 打标处理器，监听 diskqueue 中需要打标的消息，将消息交给 LLM 模型打标
type Handler struct {
}

type LabelTask struct {
	Image []byte `json:"image"`
	Type  string `json:"type,omitempty"`
}

var (
	once     sync.Once
	instance *Handler
)

func GetLabelHandler() *Handler {
	once.Do(func() {
		instance = &Handler{}
	})
	return instance
}

func (h *Handler) Start() {
	err := utils.Bus.Subscribe("label", handleLabelTask)
	if err != nil {
		log.Logger.Errorln("[label] subscribe label failed:", err)
		return
	}
}

func handleLabelTask(id string, image []byte, type_ string) {
	log.Info("label", "handle label task", zap.String("type", type_))
	label := llm.GetLlmManager().DealThinkModel("", LabelTask{Image: image, Type: type_})
	utils.Bus.Publish("labeled", id, label)
}

// Wandering 处理器，结合闲时处理任务（相关时）为 bot 生成当前手头正在进行的工作
