package log

import (
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"sync"
)

var (
	loggerInstance *zap.Logger
	loggerOnce     sync.Once
)

var logger = getLogger()

// getLogger 返回全局单例的 Zap Logger
func getLogger() *zap.Logger {
	loggerOnce.Do(func() {
		config := zap.NewProductionConfig()
		config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
		logger, _ := config.Build()
		loggerInstance = logger
	})
	loggerInstance.Sugar()
	return loggerInstance
}

func Info(name, msg string, fields ...zap.Field) {
	logger.Named(name).Info(msg, fields...)
}

func Error(name, msg string, fields ...zap.Field) {
	logger.Named(name).Error(msg, fields...)
}

func Debug(name, msg string, fields ...zap.Field) {
	logger.Named(name).Debug(msg, fields...)
}

func Warn(name, msg string, fields ...zap.Field) {
	logger.Named(name).Warn(msg, fields...)
}
