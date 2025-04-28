package face

import (
	"encoding/json"
	"github.com/OXeu/xue/internal/idle"
	"github.com/OXeu/xue/internal/message/element"
	"strings"
	"sync"
)

type Manager struct {
}

var (
	once     sync.Once
	instance *Manager
)

func GetFaceManager() *Manager {
	once.Do(func() {
		instance = &Manager{}
	})
	return instance
}

func (m Manager) AddFace(msg element.CustomFaceElement) {
	if len(msg.Alt) == 0 || strings.Contains(msg.Alt, "[动画表情]") {
		if len(msg.Label) == 0 {
			// 需要识别表情包之后再加入
			bytes, err := json.Marshal(msg)
			if err != nil {
				return
			}
			err = idle.GetIdleHandler().EmojiQueue.Put(bytes)
			if err != nil {
				return
			}
		}
	} else {

	}
}
