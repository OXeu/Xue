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
}

type Text string

type Image struct {
	Url string `json:"url,omitempty"`
	Alt string `json:"alt,omitempty"`
	Id  string `json:"id,omitempty"`
}

type CustomFaceElement struct {
	Id    string `json:"id,omitempty"`
	Alt   string `json:"alt,omitempty"`
	Label string `json:"label,omitempty"` // 通过 LLM 识别标注的表情特征（懒解析），在与模型交互时、闲时识别
	Url   string `json:"url,omitempty"`
}

type ForwardMsg struct {
	Elements []Element `json:"elements,omitempty"`
}

type ReplyMsg struct {
	ReplyMsgId uint32  `json:"reply_msg_id,omitempty"`
	Msg        Element `json:"msg,omitempty"`
}

type AtMsg struct {
	Uin  uint32 `json:"uin,omitempty"`
	Name string `json:"name,omitempty"`
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
	return nil
}
