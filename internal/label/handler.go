package label

import (
	"github.com/OXeu/Xue/internal/llm"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/utils"
	"github.com/danielhookx/xcontainer/set"
	"strings"
	"sync"
)

// Handler 打标处理器，监听 diskqueue 中需要打标的消息，将消息交给 LLM 模型打标
type Handler struct {
	working *set.Set[string]
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
		instance = &Handler{
			working: set.CreateSet[string](),
		}
	})
	return instance
}

func (h *Handler) Start() {
	err := utils.Bus.Subscribe(utils.LabelEmoji, h.handleLabelTask)
	if err != nil {
		log.Logger.Errorln("[label] subscribe label failed:", err)
		return
	}
}

func (h *Handler) handleLabelTask(id string, image []byte, type_ string) {
	if h.working.IsElementOf(id) {
		log.Logger.Infof("[Label] label task exist, skip: %s", id)
		return
	}
	err := h.working.Add(id)
	if err != nil {
		log.Logger.Errorln("[Label] add working failed:", err)
		return
	}
	defer h.working.Remove(id)
	log.Logger.Info("[Label]", "handle label task: ", id, "type:", type_)
	label, err := llm.GetLLMManager().Chat(llm.IMAGE, utils.LabelPrompt, llm.Msg{
		Role:    llm.USER,
		Content: utils.LabelUserPrompt,
		Image:   image,
	})
	if err != nil {
		log.Logger.Errorln("[Label]", "handle label task failed:", err)
		return
	}
	labelText := label.Content
	if strings.Contains(label.Content, "【") && strings.Contains(label.Content, "】") {
		labelText = strings.Split(label.Content, "【")[1]
		labelText = strings.Split(labelText, "】")[0]
	}
	log.Logger.Debugln("[Label]", "desc: ", label.Content, "label:", labelText)
	utils.Bus.Publish(utils.LabeledEmoji, id, labelText)
}

// Wandering 处理器，结合闲时处理任务（相关时）为 bot 生成当前手头正在进行的工作
