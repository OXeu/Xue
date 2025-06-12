package reactor

import (
	"github.com/OXeu/Xue/internal/face"
	"github.com/OXeu/Xue/internal/llm"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/utils"
	"math/rand"
	"strings"
)

// 响应具体的消息

type Responser struct {
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
	chat, err := llm.GetLLMManager().Chat(llm.THINK, utils.ReplyPrompt, llm.Msg{
		Role:    llm.USER,
		Content: msg.JsonContent(),
	})
	if err != nil {
		log.Logger.Errorf("[Responser] think error: %v", err)
		return
	}
	chatNext, err := llm.GetLLMManager().Chat(llm.CHAT, utils.ReplyPrompt, llm.Msg{
		Role:    llm.USER,
		Content: msg.JsonContent(),
	}, llm.Msg{
		Role:    llm.ASSIST,
		Content: "<think>" + chat.ReasoningContent + "</think>",
	})
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
	if rate < 0.8 {
		utils.Bus.Publish(utils.SendMsg, &element.SendMessage{
			Element: &[]element.Element{
				element.Text(replyMsg),
			},
			IsPrivate: msg.GID == 0,
			Uin:       msg.UID,
		})
	}
}

func (r *Responser) EmojiSender(msg *element.Message, replyMsg string) {
	// 获取表情包
	rate := rand.Float32()
	if rate < 0.5 {
		faces := face.GetFaceManager().GetFaces()
		if len(faces) > 0 {
			emojis := ""
			for _, f := range faces {
				emojis += "【" + f.Label + "】"
			}

			prompt := strings.ReplaceAll(utils.EmojiSenderPrompt, "${emojis}", emojis)
			chat, err := llm.GetLLMManager().Chat(llm.CHAT, prompt, llm.Msg{
				Role:    llm.USER,
				Content: msg.JsonContent(),
			}, llm.Msg{
				Role:    llm.ASSIST,
				Content: replyMsg,
			})
			if err != nil {
				log.Logger.Errorf("[Responser] emoji send chat error: %v", err)
				return
			}
			if chat.Content != "" {
				emojiName := utils.SubString(chat.Content, "【", "】")
				var f element.CustomFaceElement
				for _, face := range faces {
					if face.Label == emojiName {
						f = face
						break
					}
				}
				if f.ID == 0 {
					log.Logger.Infoln("[Responser] emoji not found:", emojiName)
					return
				}
				utils.Bus.Publish(utils.SendMsg, msg, &element.SendMessage{
					Element:   &[]element.Element{f},
					IsPrivate: msg.GID == 0,
					Uin:       msg.UID,
				})
			}
		}
	}
}
