package log

import (
	"fmt"
	"github.com/LagrangeDev/LagrangeGo/utils"
	"github.com/mattn/go-colorable"
	"github.com/sirupsen/logrus"
	"os"
	"path"
	"strings"
	"time"
)

const (
	// 定义颜色代码
	colorReset  = "\x1b[0m"
	colorRed    = "\x1b[31m"
	colorYellow = "\x1b[33m"
	colorGreen  = "\x1b[32m"
	colorBlue   = "\x1b[34m"
	colorWhite  = "\x1b[37m"
)

var Logger = logrus.New()

func init() {
	Logger.SetLevel(logrus.DebugLevel)
	Logger.SetFormatter(&ColoredFormatter{})
	Logger.SetOutput(colorable.NewColorableStdout())
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

	return utils.S2B(fmt.Sprintf("[%s] %s[%s]: %s%s\n",
		timestamp, levelColor, strings.ToUpper(entry.Level.String()), entry.Message, colorReset)), nil
}

// ProtocolLogger from https://github.com/Mrs4s/go-cqhttp/blob/a5923f179b360331786a6509eb33481e775a7bd1/cmd/gocq/main.go#L501
type ProtocolLogger struct{}

const fromProtocol = ""

func (p ProtocolLogger) Info(format string, arg ...any) {
	Logger.Infof(fromProtocol+format, arg...)
}

func (p ProtocolLogger) Warning(format string, arg ...any) {
	Logger.Warnf(fromProtocol+format, arg...)
}

func (p ProtocolLogger) Debug(format string, arg ...any) {
	Logger.Debugf(fromProtocol+format, arg...)
}

func (p ProtocolLogger) Error(format string, arg ...any) {
	Logger.Errorf(fromProtocol+format, arg...)
}

var (
	dumpsPath = "dump"
)

func (p ProtocolLogger) Dump(data []byte, format string, arg ...any) {
	sprintf := fmt.Sprintf(format, arg...)
	if _, err := os.Stat(dumpsPath); err != nil {
		err = os.MkdirAll(dumpsPath, 0o755)
		if err != nil {
			Logger.Errorf("出现错误 %v. 详细信息转储失败", sprintf)
			return
		}
	}
	dumpFile := path.Join(dumpsPath, fmt.Sprintf("%v.dump", time.Now().Unix()))
	Logger.Errorf("出现错误 %v. 详细信息已转储至文件 %v 请连同日志提交给开发者处理", sprintf, dumpFile)
	_ = os.WriteFile(dumpFile, data, 0o644)
}
