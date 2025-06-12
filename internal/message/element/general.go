package element

import (
	"encoding/json"
	"github.com/LagrangeDev/LagrangeGo/message"
	"gorm.io/gorm"
)

type Type = int

type Message struct {
	gorm.Model
	Id      uint      `gorm:"primaryKey" json:"id,omitempty"`
	MsgId   uint32    `json:"msg_id,omitempty"` // 本地 id，查找时需要结合 UID / GID 搜索
	UID     uint32    `json:"uid,omitempty"`
	GID     uint32    `json:"gid,omitempty"`
	ReplyTo uint32    `json:"reply_to,omitempty"` // 回复消息的本地 id
	Time    uint32    `json:"time,omitempty"`
	Content []Element `gorm:"serializer:json" json:"content,omitempty"`
}

func (m Message) JsonContent() string {
	content, err := json.Marshal(m)
	if err != nil {
		return ""
	}
	return string(content)
}

type Element interface {
	ToLagrangeMessage() message.IMessageElement
}

type Text string

func (t Text) ToLagrangeMessage() message.IMessageElement {
	return &message.TextElement{Content: string(t)}
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

type CustomFaceElement struct {
	Id    string `json:"id,omitempty"`
	Alt   string `json:"alt,omitempty"`
	Label string `json:"label,omitempty"` // 通过 LLM 识别标注的表情特征（懒解析），在与模型交互时、闲时识别
	Url   string `json:"url,omitempty"`
}

func (e CustomFaceElement) ToLagrangeMessage() message.IMessageElement {
	return &message.ImageElement{
		ImageID: e.Id,
		URL:     e.Url,
		SubType: 1,
		Flash:   false,
		Summary: e.Alt,
	}
}

type ForwardMsg struct {
	Elements [][]Element `json:"elements,omitempty"`
	Origin   *message.ForwardMessage
}

func (f ForwardMsg) ToLagrangeMessage() message.IMessageElement {
	return f.Origin
}

type ReplyMsg struct {
	ReplyMsgId uint32    `json:"reply_msg_id,omitempty"`
	Msg        []Element `json:"msg,omitempty"`
	Origin     *message.ReplyElement
}

func (r ReplyMsg) ToLagrangeMessage() message.IMessageElement {
	return r.Origin
}

type AtMsg struct {
	Uin    uint32 `json:"uin,omitempty"`
	Name   string `json:"name,omitempty"`
	Origin *message.AtElement
}

func (a AtMsg) ToLagrangeMessage() message.IMessageElement {
	return a.Origin
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
