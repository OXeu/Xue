package protocol

import (
	"errors"
	"fmt"
	"github.com/LagrangeDev/LagrangeGo/client"
	"github.com/LagrangeDev/LagrangeGo/client/auth"
	"github.com/LagrangeDev/LagrangeGo/message"
	"github.com/LagrangeDev/LagrangeGo/utils"
	"github.com/OXeu/Xue/internal/message/element"
	utils2 "github.com/OXeu/Xue/internal/utils"
	"github.com/mattn/go-colorable"
	"github.com/sirupsen/logrus"
	"os"
	"os/signal"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Lagrange struct {
	QqClient       *client.QQClient
	GroupMessage   chan *message.GroupMessage
	PrivateMessage chan *message.PrivateMessage
	Sender         chan element.SendMessage
}

var once sync.Once
var instance *Lagrange

func GetLagrange() *Lagrange {
	once.Do(func() {
		instance = &Lagrange{
			QqClient:       client.NewClientEmpty(),
			GroupMessage:   make(chan *message.GroupMessage, 100),
			PrivateMessage: make(chan *message.PrivateMessage, 100),
			Sender:         make(chan element.SendMessage, 100),
		}
	})
	return instance
}

var (
	dumpsPath = "dump"
)

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

	l.QqClient.SetLogger(protocolLogger{})
	l.QqClient.UseVersion(appInfo)
	l.QqClient.AddSignServer("https://sign.lagrangecore.org/api/sign/30366")
	l.QqClient.UseDevice(&deviceInfo)

	// 从保存的sig.bin文件读取登录信息
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

	// 订阅群消息事件
	l.QqClient.GroupMessageEvent.Subscribe(func(client *client.QQClient, event *message.GroupMessage) {
		l.GroupMessage <- event
	})

	l.QqClient.PrivateMessageEvent.Subscribe(func(client *client.QQClient, event *message.PrivateMessage) {
		l.PrivateMessage <- event
	})

	l.QqClient.DisconnectedEvent.Subscribe(func(client *client.QQClient, event *client.DisconnectedEvent) {
		logger.Infof("连接已断开：%v", event.Message)
	})

	err = func(c *client.QQClient) error {
		// 如果登录信息存在，可以使用fastlogin
		err := c.FastLogin()
		if err == nil {
			return nil
		}
		logger.Infoln("二维码登录")

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
		logger.Infof("二维码已保存至 %s", qrcodePath)
		for {
			// 轮询二维码扫描结果
			retCode, err := c.GetQRCodeResult()
			if err != nil {
				logger.Errorln(err)
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
		logger.Errorln("登录失败:", err)
		return
	}
	logger.Infoln("登录成功")

	go func() {
		for msg := range l.Sender {
			// 处理发送消息的逻辑
			if msg.IsPrivate {
				_, err = l.QqClient.SendPrivateMessage(msg.Uin, msg.ToLagrangeMessage())
				if err != nil {
					logger.Errorf("发送单聊消息失败: %v", err)
				}
			} else {
				_, err = l.QqClient.SendGroupMessage(msg.Uin, msg.ToLagrangeMessage())
				if err != nil {
					logger.Errorf("发送群聊消息失败: %v", err)
				}
			}
		}
	}()

	defer l.QqClient.Release()
	defer func() {
		// 序列化登录信息以便下次使用
		data, err = l.QqClient.Sig().Marshal()
		if err != nil {
			logger.Errorln("序列化签名错误:", err)
			return
		}
		err = os.WriteFile("data/sig.bin", data, 0644)
		if err != nil {
			logger.Errorln("写入 sig.bin 错误:", err)
			return
		}
		logger.Infoln("签名已保存至 sig.bin")
	}()

	utils2.Bus.Publish(utils2.STARTED)
	mc := make(chan os.Signal, 2)
	signal.Notify(mc, os.Interrupt, syscall.SIGTERM)
	_ = utils2.Bus.Subscribe(utils2.STOPPED, func() {
		mc <- os.Interrupt
	})
	for {
		switch <-mc {
		case os.Interrupt, syscall.SIGTERM:
			return
		}
	}
}

// protocolLogger from https://github.com/Mrs4s/go-cqhttp/blob/a5923f179b360331786a6509eb33481e775a7bd1/cmd/gocq/main.go#L501
type protocolLogger struct{}

const fromProtocol = "Lgr -> "

func (p protocolLogger) Info(format string, arg ...any) {
	logger.Infof(fromProtocol+format, arg...)
}

func (p protocolLogger) Warning(format string, arg ...any) {
	logger.Warnf(fromProtocol+format, arg...)
}

func (p protocolLogger) Debug(format string, arg ...any) {
	logger.Debugf(fromProtocol+format, arg...)
}

func (p protocolLogger) Error(format string, arg ...any) {
	logger.Errorf(fromProtocol+format, arg...)
}

func (p protocolLogger) Dump(data []byte, format string, arg ...any) {
	sprintf := fmt.Sprintf(format, arg...)
	if _, err := os.Stat(dumpsPath); err != nil {
		err = os.MkdirAll(dumpsPath, 0o755)
		if err != nil {
			logger.Errorf("出现错误 %v. 详细信息转储失败", sprintf)
			return
		}
	}
	dumpFile := path.Join(dumpsPath, fmt.Sprintf("%v.dump", time.Now().Unix()))
	logger.Errorf("出现错误 %v. 详细信息已转储至文件 %v 请连同日志提交给开发者处理", sprintf, dumpFile)
	_ = os.WriteFile(dumpFile, data, 0o644)
}

const (
	// 定义颜色代码
	colorReset  = "\x1b[0m"
	colorRed    = "\x1b[31m"
	colorYellow = "\x1b[33m"
	colorGreen  = "\x1b[32m"
	colorBlue   = "\x1b[34m"
	colorWhite  = "\x1b[37m"
)

var logger = logrus.New()

func init() {
	logger.SetLevel(logrus.TraceLevel)
	logger.SetFormatter(&ColoredFormatter{})
	logger.SetOutput(colorable.NewColorableStdout())
}

type ColoredFormatter struct{}

func (f *ColoredFormatter) Format(entry *logrus.Entry) ([]byte, error) {
	// 获取当前时间戳
	timestamp := time.Now().Format("2006-01-02 15:04:05")

	// 根据日志级别设置相应的颜色
	var levelColor string
	switch entry.Level {
	case logrus.DebugLevel:
		levelColor = colorBlue
	case logrus.InfoLevel:
		levelColor = colorGreen
	case logrus.WarnLevel:
		levelColor = colorYellow
	case logrus.ErrorLevel, logrus.FatalLevel, logrus.PanicLevel:
		levelColor = colorRed
	default:
		levelColor = colorWhite
	}

	return utils.S2B(fmt.Sprintf("[%s] [%s%s%s]: %s\n",
		timestamp, levelColor, strings.ToUpper(entry.Level.String()), colorReset, entry.Message)), nil
}
