package message

import (
	"encoding/json"
	"github.com/LagrangeDev/LagrangeGo/message"
	face2 "github.com/OXeu/xue/internal/face"
	"github.com/OXeu/xue/internal/history"
	"github.com/OXeu/xue/internal/message/element"
	"github.com/OXeu/xue/internal/message/protocol"
	"log"
)

// Receiver 接收器：接收并转换消息，将消息转发给其他组件
type Receiver struct {
	// 消息接收器的字段
}

func NewReceiver() *Receiver {
	return &Receiver{}
}

func (r *Receiver) Start() {
	lagrange := protocol.GetLagrange()
	for msg := range lagrange.GroupMessage {
		generalMsgContent, replyId := convertMessage(msg.Elements)
		jsonMsg, err := json.Marshal(generalMsgContent)
		if err != nil {
			log.Fatal("json marshal err: ", err)
		}
		log.Printf("Received group message(%d,%d,%d,%d) %s : %v", msg.ID, msg.InternalID, msg.GroupUin, msg.Time, msg.Sender.UID, string(jsonMsg))
		generalMsg := element.Message{
			MsgId:   msg.ID,
			UID:     msg.Sender.Uin,
			GID:     msg.GroupUin,
			ReplyTo: replyId,
			Content: generalMsgContent,
		}
		history.GetHistory().Write(&generalMsg)
		history.GetEmbedding().Write(&generalMsg)
	}
}

func convertMessage(messages []message.IMessageElement) ([]element.Element, uint32) {
	commonMsg := make([]element.Element, 0)
	var replyId uint32
	for _, ele := range messages {
		msg, subReplyId := convertMessageElement(ele)
		if subReplyId != 0 {
			replyId = subReplyId
		}
		commonMsg = append(commonMsg, msg)
	}
	return commonMsg, replyId
}

func convertMessageElement(ele message.IMessageElement) (element.Element, uint32) {
	switch ele.(type) {
	case *message.TextElement:
		text := ele.(*message.TextElement)
		return text.Content, 0
	case *message.ReplyElement:
		reply := ele.(*message.ReplyElement)
		msg, _ := convertMessage(reply.Elements)
		return element.ReplyMsg{Msg: msg, ReplyMsgId: reply.ReplySeq}, reply.ReplySeq
	case *message.AtElement:
		at := ele.(*message.AtElement)
		return element.AtMsg{Uin: at.TargetUin, Name: at.Display}, 0
	case *message.ImageElement:
		image := ele.(*message.ImageElement)
		if image.SubType == 1 {
			// 表情
			face := element.CustomFaceElement{Alt: image.Summary, Url: image.URL, Id: image.ImageID}
			go face2.GetFaceManager().AddFace(face)
			return face, 0
		} else {
			// 图片
			return element.Image{Id: image.ImageID, Alt: image.Summary, Url: image.URL}, 0
		}
	case *message.LightAppElement:
		app := ele.(*message.LightAppElement)
		log.Printf("light app element: %s", app.Content)
		return nil, 0
	case *message.XMLElement:
		xml := ele.(*message.XMLElement)
		log.Printf("xml element: %s", xml.Content)
		return nil, 0
	case *message.ForwardMessage:
		forward := ele.(*message.ForwardMessage)
		elements := make([]element.Element, 0)
		for _, node := range forward.Nodes {
			data, _ := convertMessage(node.Message)
			elements = append(elements, data)
		}
		return element.ForwardMsg{Elements: elements}, 0
	case *message.MarketFaceElement:
		face := ele.(*message.MarketFaceElement)
		return element.CustomFaceElement{Alt: face.Summary, Url: ""}, 0
	default:
		log.Printf("unknown element type: %d", ele.Type())
	}
	return nil, 0
}
