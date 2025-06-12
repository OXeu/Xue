package main

import (
	"github.com/OXeu/Xue/internal/face"
	"github.com/OXeu/Xue/internal/history"
	"github.com/OXeu/Xue/internal/idle"
	"github.com/OXeu/Xue/internal/label"
	"github.com/OXeu/Xue/internal/message/protocol"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	go protocol.GetLagrange().Start()
	go face.GetFaceManager().Start()
	go history.GetEmbedding().Start()
	go history.GetHistory().Start()
	go idle.GetIdleHandler().Start()
	go label.GetLabelHandler().Start()

	// 主程序循环
	mc := make(chan os.Signal, 2)
	signal.Notify(mc, os.Interrupt, syscall.SIGTERM)
	for {
		switch <-mc {
		case os.Interrupt, syscall.SIGTERM:
			time.Sleep(1 * time.Second)
			return
		}
	}
}
