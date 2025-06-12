package main

import (
	"github.com/OXeu/Xue/internal/message"
	"github.com/OXeu/Xue/internal/message/protocol"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	go protocol.GetLagrange().Start()
	go message.NewReceiver().Start()

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
