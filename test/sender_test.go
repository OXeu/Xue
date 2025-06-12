package test

import (
	message2 "github.com/LagrangeDev/LagrangeGo/message"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/message/protocol"
	"github.com/OXeu/Xue/internal/utils"
	"os"
	"testing"
	"time"
)

func TestSendPriMsg(t *testing.T) {
	err := utils.Bus.Subscribe(utils.STARTED, func() {
		log.Info("TestSendPriMsg", "started service")
		data, err := os.ReadFile("data/image.jpeg")
		if err != nil {
			t.Error(err)
		}
		protocol.GetLagrange().Sender <- element.SendMessage{
			Uin:       1573856599,
			IsPrivate: true,
			Element: &[]element.Element{
				element.Text("Hello!"),
				protocol.LocalImage{Data: data, Source: message2.Source{
					SourceType: message2.SourcePrivate,
					PrimaryID:  1573856599,
				}},
			},
		}
		go func() {
			time.Sleep(5 * time.Second)
			utils.Bus.Publish(utils.STOPPED)
		}()
	})
	if err != nil {
		t.Error(err)
	}
	protocol.GetLagrange().Start()
}
