package protocol

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/LagrangeDev/LagrangeGo/client"
	"github.com/LagrangeDev/LagrangeGo/client/auth"
	"github.com/LagrangeDev/LagrangeGo/message"
	face2 "github.com/OXeu/Xue/internal/face"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	utils2 "github.com/OXeu/Xue/internal/utils"
	"github.com/sirupsen/logrus"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

type Lagrange struct {
	QqClient       *client.QQClient
	GroupMessage   chan *message.GroupMessage
	PrivateMessage chan *message.PrivateMessage
}

var once sync.Once
var instance *Lagrange

func GetLagrange() *Lagrange {
	once.Do(func() {
		instance = &Lagrange{
			QqClient:       client.NewClientEmpty(),
			GroupMessage:   make(chan *message.GroupMessage, 100),
			PrivateMessage: make(chan *message.PrivateMessage, 100),
		}
	})
	return instance
}

func (l *Lagrange) Start() {
	//conf := config.GetConfig()
	// 使用特定的协议版本
	appInfo := auth.AppList["linux"]["3.2.15-30366"]
	// 创建设备信息
	//uin := conf.GetIntOrDefault(config.UIN, 3042160393)
	deviceInfo := auth.DeviceInfo{
		GUID:          "8b3e6c8892424381875cef6c53aae34c",
		DeviceName:    "Lagrange-E7A109",
		SystemKernel:  "Windows 10.0.19042",
		KernelVersion: "10.0.19042.0",
	}

	l.QqClient.SetLogger(log.ProtocolLogger{})
	l.QqClient.UseVersion(appInfo)
	l.QqClient.AddSignServer("https://sign.lagrangecore.org/api/sign/30366")
	l.QqClient.UseDevice(&deviceInfo)

	// 从保存的sig.bin文件读取登录信息
	exist, err := utils2.FileExists("data/sig.bin")
	if exist {
		data, err := os.ReadFile("data/sig.bin")
		if err != nil {
			logrus.Warnln("读取签名错误:", err)
		} else {
			// 将登录信息反序列化
			sig, err := auth.UnmarshalSigInfo(data, true)
			if err != nil {
				logrus.Warnln("反序列化签名错误:", err)
			} else {
				// 如果登录信息有效，则使用登录信息登录
				l.QqClient.UseSig(sig)
			}
		}
	}

	// 订阅群消息事件
	l.QqClient.GroupMessageEvent.Subscribe(func(client *client.QQClient, event *message.GroupMessage) {
		generalMsgContent, replyId, isAtMe := convertMessage(event.Elements)
		jsonMsg, err := json.Marshal(generalMsgContent)
		if err != nil {
			log.Logger.Fatal("json marshal err: ", err)
		}
		log.Logger.Printf("Received group message(%d,%d,%d,%d) %s : %v", event.ID, event.InternalID, event.GroupUin, event.Time, event.Sender.UID, string(jsonMsg))
		var content string
		for _, ele := range generalMsgContent {
			if ele != nil {
				content += ele.ToReadableString() + "\n"
			}
		}
		generalMsg := element.Message{
			MsgId:         event.ID,
			UID:           event.Sender.Uin,
			NickName:      event.Sender.Nickname,
			SessionId:     event.GroupUin,
			IsPrivate:     false,
			ReplyTo:       replyId,
			Content:       content,
			Time:          event.Time,
			IsRelatedToMe: isAtMe,
		}
		utils2.Bus.Publish(utils2.PreReceiveMsg, &generalMsg)
	})

	l.QqClient.PrivateMessageEvent.Subscribe(func(client *client.QQClient, msg *message.PrivateMessage) {
		generalMsgContent, replyId, isAtMe := convertMessage(msg.Elements)
		jsonMsg, err := json.Marshal(generalMsgContent)
		if err != nil {
			log.Logger.Fatal("json marshal err: ", err)
		}
		log.Logger.Printf("Received private message(%d,%d,%d) %s : %v", msg.ID, msg.InternalID, msg.Time, msg.Sender.UID, string(jsonMsg))
		var content string
		for _, ele := range generalMsgContent {
			content += ele.ToReadableString() + "\n"
		}
		generalMsg := element.Message{
			MsgId:         msg.ID,
			UID:           msg.Sender.Uin,
			NickName:      msg.Sender.Nickname,
			SessionId:     msg.Sender.Uin,
			IsPrivate:     true,
			ReplyTo:       replyId,
			Time:          msg.Time,
			Content:       content,
			IsRelatedToMe: isAtMe,
		}
		utils2.Bus.Publish(utils2.PreReceiveMsg, &generalMsg)
	})

	l.QqClient.DisconnectedEvent.Subscribe(func(client *client.QQClient, event *client.DisconnectedEvent) {
		log.Logger.Infof("连接已断开：%v", event.Message)
	})

	err = func(c *client.QQClient) error {
		// 如果登录信息存在，可以使用fastlogin
		err := c.FastLogin()
		if err == nil {
			return nil
		}
		log.Logger.Infoln("二维码登录")

		// 扫码登录流程
		// 首先获取二维码
		png, _, err := c.FetchQRCodeDefault()
		if err != nil {
			return err
		}
		qrcodePath := "data/qrcode.png"
		// 保存到本地以供扫码
		err = os.WriteFile(qrcodePath, png, 0666)
		if err != nil {
			return err
		}
		log.Logger.Infof("二维码已保存至 %s", qrcodePath)
		for {
			// 轮询二维码扫描结果
			retCode, err := c.GetQRCodeResult()
			if err != nil {
				log.Logger.Errorln(err)
				return err
			}
			// 等待扫码
			if retCode.Waitable() {
				time.Sleep(3 * time.Second)
				continue
			}
			if !retCode.Success() {
				return errors.New(retCode.Name())
			}
			break
		}
		// 扫码完成后就可以进行登录
		_, err = c.QRCodeLogin()
		return err
	}(l.QqClient)

	if err != nil {
		log.Logger.Errorln("登录失败:", err)
		return
	}
	log.Logger.Infoln("登录成功")

	go func() {
		err := utils2.Bus.Subscribe(utils2.SendMsg, func(msg *element.SendMessage) {
			var debugMsg string
			for _, ele := range *msg.Element {
				debugMsg += ele.ToReadableString() + ";"
			}
			log.Logger.Infof("发送消息: %d(%v) -> %s", msg.TargetId, msg.IsPrivate, debugMsg)
			// 处理发送消息的逻辑
			if msg.IsPrivate {
				_, err = l.QqClient.SendPrivateMessage(msg.TargetId, msg.ToLagrangeMessage())
				if err != nil {
					log.Logger.Errorf("发送单聊消息失败: %v", err)
				}
				utils2.Bus.Publish(utils2.SentMsg, msg)
			} else {
				_, err = l.QqClient.SendGroupMessage(msg.TargetId, msg.ToLagrangeMessage())
				if err != nil {
					log.Logger.Errorf("发送群聊消息失败: %v", err)
				}
				utils2.Bus.Publish(utils2.SentMsg, msg)
			}
		})
		if err != nil {
			log.Logger.Error("发送消息失败", err)
		}
	}()

	defer l.QqClient.Release()
	defer func() {
		// 序列化登录信息以便下次使用
		data, err := l.QqClient.Sig().Marshal()
		if err != nil {
			log.Logger.Errorln("序列化签名错误:", err)
			return
		}
		err = os.WriteFile("data/sig.bin", data, 0644)
		if err != nil {
			log.Logger.Errorln("写入 sig.bin 错误:", err)
			return
		}
		log.Logger.Infoln("签名已保存至 sig.bin")
	}()

	utils2.Bus.Publish(utils2.Started)
	mc := make(chan os.Signal, 2)
	signal.Notify(mc, os.Interrupt, syscall.SIGTERM)
	_ = utils2.Bus.Subscribe(utils2.Stopped, func() {
		mc <- os.Interrupt
	})
	for {
		switch <-mc {
		case os.Interrupt, syscall.SIGTERM:
			return
		}
	}
}

func convertMessage(messages []message.IMessageElement) ([]element.Element, uint32, bool) {
	isAt := false
	commonMsg := make([]element.Element, 0)
	var replyId uint32
	for _, ele := range messages {
		msg, subReplyId, at := convertMessageElement(ele)
		if at {
			isAt = true
		}
		if subReplyId != 0 {
			replyId = subReplyId
		}
		commonMsg = append(commonMsg, msg)
	}
	return commonMsg, replyId, isAt
}

func convertMessageElement(ele message.IMessageElement) (element.Element, uint32, bool) {
	isAtMe := false
	switch ele.(type) {
	case *message.TextElement:
		text := ele.(*message.TextElement)
		return element.Text(text.Content), 0, false
	case *message.ReplyElement:
		reply := ele.(*message.ReplyElement)
		msg, _, _ := convertMessage(reply.Elements)
		if reply.SenderUin == GetLagrange().QqClient.Uin {
			isAtMe = true
		}
		return element.ReplyMsg{Msg: msg, ReplyMsgId: reply.ReplySeq, Origin: reply}, reply.ReplySeq, isAtMe
	case *message.AtElement:
		at := ele.(*message.AtElement)
		if at.TargetUin == GetLagrange().QqClient.Uin {
			isAtMe = true
		}
		return element.AtMsg{Uin: at.TargetUin, Name: at.Display, Origin: at}, 0, isAtMe
	case *message.ImageElement:
		image := ele.(*message.ImageElement)
		if image.SubType == 1 {
			// 表情
			f := face2.GetFaceManager().GetFace(image.ImageID)
			face := element.CustomFaceElement{Url: image.URL, Id: image.ImageID, Md5: hex.EncodeToString(image.Md5)}
			if len(f.Label) != 0 {
				face.Label = f.Label
			}
			log.Logger.Infof("[Lagrange] 接收到表情[%s]: %s, %s, %s", face.Label, face.Id, face.Url, image.Summary)
			utils2.Bus.Publish(utils2.ReceiveEmoji, &face)
			return face, 0, false
		} else {
			// 图片
			return element.Image{Id: image.ImageID, Alt: image.Summary, Url: image.URL}, 0, false
		}
	case *message.LightAppElement:
		app := ele.(*message.LightAppElement)
		log.Logger.Printf("light app element: %s", app.Content)
		return nil, 0, false
	case *message.XMLElement:
		xml := ele.(*message.XMLElement)
		log.Logger.Printf("xml element: %s", xml.Content)
		return nil, 0, false
	case *message.ForwardMessage:
		forward := ele.(*message.ForwardMessage)
		elements := make([][]element.Element, 0)
		for _, node := range forward.Nodes {
			data, _, _ := convertMessage(node.Message)
			elements = append(elements, data)
		}
		return element.ForwardMsg{Elements: elements, Origin: forward}, 0, false
	case *message.MarketFaceElement:
		face := ele.(*message.MarketFaceElement)
		return element.CustomFaceElement{Label: face.Summary, Url: ""}, 0, false
	default:
		log.Logger.Printf("unknown element type: %d", ele.Type())
	}
	return nil, 0, false
}
