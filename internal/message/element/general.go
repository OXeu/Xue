package element

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/LagrangeDev/LagrangeGo/message"
	"github.com/OXeu/Xue/internal/llm"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/utils"
	"gorm.io/gorm"
	"time"
)

type Type = int

type Message struct {
	gorm.Model
	Id       uint   `gorm:"primaryKey" json:"id,omitempty"`
	MsgId    uint32 `json:"msg_id,omitempty"` // 本地 id，查找时需要结合 UID / GID 搜索
	UID      uint32 `json:"uid,omitempty"`
	NickName string `json:"nick_name,omitempty"`
	GID      uint32 `json:"gid,omitempty"`      // 群 id，私聊为 0
	ReplyTo  uint32 `json:"reply_to,omitempty"` // 回复消息的本地 id
	Time     uint32 `json:"time,omitempty"`
	Content  string `json:"content,omitempty"`
}

func (m Message) JsonContent() string {
	content, err := json.Marshal(m)
	if err != nil {
		return ""
	}
	return string(content)
}

func (m Message) ReadableContent() string {
	t := time.Unix(int64(m.Time), 0)
	id := m.GID
	if id == 0 {
		id = m.UID
	}
	return fmt.Sprintf("%s\n%s:%s", t.Format("2006-01-02 15:04:05"), m.NickName, m.Content)
}

type Element interface {
	ToLagrangeMessage() message.IMessageElement
	ToReadableString() string
}

type Text string

func (t Text) ToLagrangeMessage() message.IMessageElement {
	return &message.TextElement{Content: string(t)}
}

func (t Text) ToReadableString() string {
	return string(t)
}

type Image struct {
	Url string `json:"url,omitempty"`
	Alt string `json:"alt,omitempty"`
	Id  string `json:"id,omitempty"`
}

func (i Image) ToLagrangeMessage() message.IMessageElement {
	return &message.ImageElement{
		ImageID: i.Id,
		URL:     i.Url,
		SubType: 0,
		Flash:   false,
		Summary: i.Alt,
	}
}

func (i Image) ToReadableString() string {
	image, err := i.GetImage()
	if err != nil {
		log.Logger.Error("[Image] read image error: ", err)
		return "[图片](读取图片失败)"
	}
	chat, err := llm.GetLLMManager().Chat(llm.IMAGE, utils.ImagePrompt, llm.Msg{
		Role:    llm.USER,
		Content: "",
		Image:   image,
	})
	if err != nil {
		log.Logger.Error("[Image] handle image failed: ", err)
		return "[图片](理解图片失败)"
	}
	return fmt.Sprintf("[图片]\n```\n%s\n```", chat.Content)
}

type CustomFaceElement struct {
	gorm.Model
	Id    string `gorm:"primaryKey" json:"id,omitempty"`
	Label string `json:"label,omitempty"` // 通过 LLM 识别标注的表情特征（懒解析），在与模型交互时、闲时识别
	Url   string `json:"url,omitempty"`
	Md5   string `json:"md5"`
}

func (e CustomFaceElement) ToLagrangeMessage() message.IMessageElement {
	image, err := e.GetImage()
	if err != nil {
		log.Logger.Error("[Emoji] read emoji error: ", err)
		return nil
	}
	return &message.ImageElement{
		ImageID: e.Id,
		URL:     e.Url,
		Size:    uint32(len(image)),
		Md5:     utils.Md5Bytes(image),
		Sha1:    utils.Sha1Bytes(image),
		SubType: 1,
		Stream:  bytes.NewReader(image),
		Flash:   false,
	}
}

func (e CustomFaceElement) ToReadableString() string {
	if len(e.Label) == 0 {
		image, err := e.GetImage()
		if err != nil {
			log.Logger.Error("[Emoji] read emoji error: ", err)
			return "[表情](读取表情包失败)"
		}
		utils.Bus.Publish(utils.LabelEmoji, e.Id, image, "emoji")
		ch := make(chan string)
		err = utils.Bus.Subscribe(utils.LabeledEmoji, func(id, label string) {
			log.Logger.Infof("update emoji[%s] label:%s", id, label)
			if id == e.Id {
				ch <- label
			}
		})
		if err != nil {
			log.Logger.Error("[Emoji] update emoji label failed: ", err)
			return "[表情](更新标签失败)"
		}
		log.Logger.Infof("[Emoji] waiting emoji label: %s", e.Id)
		label := <-ch
		return fmt.Sprintf("[表情](%s)", label)
	}
	return fmt.Sprintf("[表情](%s)", e.Label)
}

type ForwardMsg struct {
	Elements [][]Element `json:"elements,omitempty"`
	Origin   *message.ForwardMessage
}

func (f ForwardMsg) ToLagrangeMessage() message.IMessageElement {
	return f.Origin
}

func (f ForwardMsg) ToReadableString() string {
	var content string
	for _, elements := range f.Elements {
		for _, element := range elements {
			content += element.ToReadableString()
		}
		content += "\n"
	}
	return fmt.Sprintf("[转发]\n%s", content)
}

type ReplyMsg struct {
	ReplyMsgId uint32    `json:"reply_msg_id,omitempty"`
	Msg        []Element `json:"msg,omitempty"`
	Origin     *message.ReplyElement
}

func (r ReplyMsg) ToLagrangeMessage() message.IMessageElement {
	return r.Origin
}

func (r ReplyMsg) ToReadableString() string {
	var content string
	for _, element := range r.Msg {
		content += element.ToReadableString()
	}
	return fmt.Sprintf("[回复]{%s}", content)
}

type AtMsg struct {
	Uin    uint32 `json:"uin,omitempty"`
	Name   string `json:"name,omitempty"`
	Origin *message.AtElement
}

func (a AtMsg) ToLagrangeMessage() message.IMessageElement {
	return a.Origin
}

func (a AtMsg) ToReadableString() string {
	return fmt.Sprintf("%s", a.Name)
}

type CardMsg struct {
	Title   string `json:"title,omitempty"`
	Summary string `json:"summary,omitempty"`
	Url     string `json:"url,omitempty"`
}

type SendMessage struct {
	Uin       uint32     `json:"uin,omitempty"`
	IsPrivate bool       `json:"is_private,omitempty"`
	Element   *[]Element `json:"element,omitempty"`
}

func (m *SendMessage) ToLagrangeMessage() []message.IMessageElement {
	var nodes []message.IMessageElement
	for _, e := range *m.Element {
		nodes = append(nodes, e.ToLagrangeMessage())
	}
	return nodes
}
