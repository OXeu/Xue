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
	err := utils.Bus.Subscribe(utils.STARTED, func() {
		log.Logger.Infoln("[TestSendPriMsg] started service")
		data, err := os.ReadFile("data/image.jpeg")
		if err != nil {
			t.Error(err)
		}
		utils.Bus.Publish(utils.SEND_MSG, &element.SendMessage{
			Uin:       1573856599,
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
		_ = utils.Bus.Subscribe(utils.SENDED_MSG, func(msg *element.SendMessage) {
			utils.Bus.Publish(utils.STOPPED)
		})
	})
	if err != nil {
		t.Error(err)
	}
	protocol.GetLagrange().Start()
}
