package reactor

import (
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/utils"
	"math/rand"
	"sync"
)

// Reactor 反应系统
// 根据内部状态与外部环境决定是否反应以及如何反应
// 内部状态：Mock 模拟的生活状态 & 实际模型忙碌状态
// 外部环境：新消息通知 & 时间唤醒 & 事件唤醒

type Reactor struct {
}

var (
	reactorOnce     sync.Once
	reactorInstance *Reactor
)

func GetReactor() *Reactor {
	reactorOnce.Do(func() {
		reactorInstance = &Reactor{}
	})
	return reactorInstance
}

func (r *Reactor) Start() {
	err := utils.Bus.Subscribe(utils.ReceiveMsg, r.reactMessage)
	if err != nil {
		log.Logger.Errorf("[Reactor] error subscribe recv_msg: %v", err)
		return
	}
}

// 响应消息（即时）
func (r *Reactor) reactMessage(msg *element.Message) {
	// 获取当前计划
	log.Logger.Infof("[Reactor] react message")
	internal := GetInternal()
	plan := internal.Current
	if plan != nil {
		rate := rand.Float32()
		if rate < plan.GetResponseRate() {
			// response
			log.Logger.Infoln("[Reactor] response")
			utils.Bus.Publish(utils.ReplyMsg, msg)
		} else {
			log.Logger.Infof("[Reactor] %f > %f, skip response", rate, plan.GetResponseRate())
		}
	} else {
		log.Logger.Infoln("[Reactor] plan not ready")
		return
	}
}

// 响应消息（延迟）
func (r *Reactor) delayReactMessage() {

}
