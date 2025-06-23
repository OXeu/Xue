package reactor

import (
	"github.com/OXeu/Xue/internal/config"
	"github.com/OXeu/Xue/internal/face"
	"github.com/OXeu/Xue/internal/history"
	"github.com/OXeu/Xue/internal/llm"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/message/protocol"
	"github.com/OXeu/Xue/internal/utils"
	"math/rand"
	"strings"
	"sync"
	"time"
)

// 响应具体的消息

type Responser struct {
	isResponding sync.Mutex
}

func GetResponser() *Responser {
	return &Responser{}
}

func (r *Responser) Start() {
	go func() {
		err := utils.Bus.Subscribe(utils.ReplyMsg, r.ReplyMsg)
		if err != nil {
			log.Logger.Errorln("[Responser] subscribe reply msg error:", err)
			return
		}
	}()
	go func() {
		err := utils.Bus.Subscribe(utils.PreSendMsg, r.PostHandleMsg)
		if err != nil {
			log.Logger.Errorln("[Responser] subscribe reply msg error:", err)
			return
		}
	}()
}

func (r *Responser) ReplyMsg(msg *element.Message) {
	if r.isResponding.TryLock() == false {
		log.Logger.Infoln("[Reactor] is responding, skip")
		return
	}
	defer r.isResponding.Unlock()
	thinkPrompt := strings.ReplaceAll(utils.ReplyThinkPrompt, "${time}", time.Now().Format("2006-01-02 15:04:05"))
	prompt := strings.ReplaceAll(utils.ReplyPrompt, "${time}", time.Now().Format("2006-01-02 15:04:05"))
	var historyMsg []llm.Msg
	botUIN := protocol.GetLagrange().QqClient.Uin
	historyMsgPack := history.GetHistory().RecallHistory(msg.SessionId, msg.IsPrivate, msg.ReplyTo)
	for _, h := range historyMsgPack {
		if h.UID == botUIN {
			contentSplit := strings.Split(h.Content, ";")
			for _, c := range contentSplit {
				if len(c) > 0 {
					historyMsg = append(historyMsg, llm.Msg{
						Role:    llm.ASSIST,
						Content: c,
					})
				}
			}
		} else {
			historyMsg = append(historyMsg, llm.Msg{
				Role:    llm.USER,
				Content: h.ReadableContent(),
			})
		}
	}
	historyMsg = append(historyMsg, llm.Msg{
		Role:    llm.USER,
		Content: msg.ReadableContent(),
	})
	chat, err := llm.GetLLMManager().Chat(config.THINK, thinkPrompt, historyMsg...)
	if err != nil {
		log.Logger.Errorf("[Responser] think error: %v", err)
		return
	}
	historyMsg = append(historyMsg, llm.Msg{
		Role:    llm.ASSIST,
		Content: "<think>" + chat.ReasoningContent + "</think>",
	})
	chatNext, err := llm.GetLLMManager().Chat(config.CHAT, prompt, historyMsg...)
	if err != nil {
		log.Logger.Errorf("[Responser] chat error: %v", err)
		return
	}
	log.Logger.Infoln("[Responser] ", chatNext)
	utils.Bus.Publish(utils.PreSendMsg, msg, chatNext.Content)
}

func (r *Responser) PostHandleMsg(msg *element.Message, replyMsg string) {
	replyMsg = strings.TrimSpace(replyMsg)
	// 后处理，随机添加表情包，随机添加错别字，随机字典替换
	r.EmojiSender(msg, replyMsg)
	rate := rand.Float32()
	if rate < 0.99 {
		utils.Bus.Publish(utils.SendMsg, &element.SendMessage{
			Element: &[]element.Element{
				element.Text(replyMsg),
			},
			IsPrivate: msg.IsPrivate,
			TargetId:  msg.SessionId,
		})
	} else {
		log.Logger.Infoln("[Responser] skip send text")
	}
}

func (r *Responser) EmojiSender(msg *element.Message, replyMsg string) {
	// 获取表情包
	rate := rand.Float32()
	if rate < 0.9 {
		log.Logger.Infoln("[Responser] start emoji sender")
		faces := face.GetFaceManager().GetLabeledFaces()
		if len(faces) > 0 {
			emojis := ""
			for _, f := range faces {
				emojis += "【" + f.Label + "】"
			}

			prompt := strings.ReplaceAll(utils.EmojiSenderPrompt, "${emojis}", emojis)
			var historyMsg []llm.Msg
			historyMsgPack := history.GetHistory().RecallHistory(msg.MsgId, msg.IsPrivate, msg.ReplyTo)
			for _, h := range historyMsgPack {
				historyMsg = append(historyMsg, llm.Msg{
					Role:    llm.USER,
					Content: h.ReadableContent(),
				})
			}
			historyMsg = append(historyMsg, llm.Msg{
				Role:    llm.USER,
				Content: msg.ReadableContent(),
			})
			historyMsg = append(historyMsg, llm.Msg{
				Role:    llm.ASSIST,
				Content: replyMsg,
			})
			chat, err := llm.GetLLMManager().Chat(config.CHAT, prompt, historyMsg...)
			if err != nil {
				log.Logger.Errorf("[Responser] emoji send chat error: %v", err)
				return
			}
			if chat.Content != "" {
				emojiName := utils.SubString(chat.Content, "【", "】")
				if len(emojiName) == 0 {
					log.Logger.Infof("[Responser] emoji name is empty: [%s]", emojiName)
				}
				var f element.CustomFaceElement
				for _, ff := range faces {
					if strings.Contains(ff.Label, emojiName) {
						f = ff
						break
					}
				}
				if len(f.Id) == 0 {
					log.Logger.Infof("[Responser] emoji not found: [%s]", emojiName)
					return
				}
				utils.Bus.Publish(utils.SendMsg, &element.SendMessage{
					Element:   &[]element.Element{f},
					IsPrivate: msg.IsPrivate,
					TargetId:  msg.SessionId,
				})
			}
		} else {
			log.Logger.Infoln("[Emoji Sender] no emoji found")
		}
	} else {
		log.Logger.Infof("[Emoji Sender] %f < %f, skip emoji", rate, 0.5)
	}
}
