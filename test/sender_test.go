package test

import (
	message2 "github.com/LagrangeDev/LagrangeGo/message"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/message/protocol"
	"github.com/OXeu/Xue/internal/utils"
	"os"
	"testing"
)

func TestSendPriMsg(t *testing.T) {
	err := utils.Bus.Subscribe(utils.Started, func() {
		log.Logger.Infoln("[TestSendPriMsg] started service")
		data, err := os.ReadFile("data/image.jpeg")
		if err != nil {
			t.Error(err)
		}
		utils.Bus.Publish(utils.SendMsg, &element.SendMessage{
			TargetId:  1573856599,
			IsPrivate: true,
			Element: &[]element.Element{
				protocol.LocalImage{
					Data: data,
					Source: message2.Source{
						SourceType: message2.SourcePrivate,
						PrimaryID:  1573856599,
					},
					SubType: 1,
				},
			},
		})
		_ = utils.Bus.Subscribe(utils.SentMsg, func(msg *element.SendMessage) {
			utils.Bus.Publish(utils.Stopped)
		})
	})
	if err != nil {
		t.Error(err)
	}
	protocol.GetLagrange().Start()
}

func TestSendGrpMsg(t *testing.T) {
	err := utils.Bus.Subscribe(utils.Started, func() {
		log.Logger.Infoln("[TestSendGrpMsg] started service")
		data, err := os.ReadFile("data/emojis/1DB6CE6F2CBD8107E09F52C10B131D1A.jpg")
		if err != nil {
			t.Error(err)
		}
		utils.Bus.Publish(utils.SendMsg, &element.SendMessage{
			TargetId:  993717305,
			IsPrivate: false,
			Element: &[]element.Element{
				element.Text("hello world"),
				protocol.LocalImage{
					Data: data,
					Source: message2.Source{
						SourceType: message2.SourceGroup,
						PrimaryID:  993717305,
					},
					SubType: 1,
				},
			},
		})
		_ = utils.Bus.Subscribe(utils.SentMsg, func(msg *element.SendMessage) {
			utils.Bus.Publish(utils.Stopped)
		})
	})
	if err != nil {
		t.Error(err)
	}
	protocol.GetLagrange().Start()
}
