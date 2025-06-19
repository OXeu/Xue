package test

import (
	"github.com/OXeu/Xue/internal/face"
	"github.com/OXeu/Xue/internal/label"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/message/protocol"
	"github.com/OXeu/Xue/internal/utils"
	"gorm.io/gorm"
	"testing"
)

func TestFace(t *testing.T) {
	label.GetLabelHandler().Start()
	face := element.CustomFaceElement{
		Model: gorm.Model{},
		Id:    "B6A23517D4BAF62C054403268EAAB58E.jpg",
		Label: "",
		Url:   "",
		Md5:   "",
	}
	t.Logf("face: [%s]", face.ToReadableString())
}

func TestFaceSend(t *testing.T) {
	go protocol.GetLagrange().Start()
	utils.Bus.Subscribe(utils.Started, func() {
		faces := face.GetFaceManager().GetLabeledFaces()
		if len(faces) > 1 {
			f := faces[0]
			utils.Bus.Publish(utils.SendMsg, &element.SendMessage{
				TargetId:  1573856599,
				Element:   &[]element.Element{f},
				IsPrivate: true,
			})
		}
	})
	ch := make(chan bool)
	err := utils.Bus.SubscribeSync(utils.SentMsg, func(msg *element.SendMessage) {
		ch <- true
	})
	if err != nil {
		return
	}
	<-ch
}
