package api

import (
	"embed"
	"github.com/OXeu/Xue/internal/log"
	"github.com/gin-gonic/gin"
	"io/fs"
	"net/http"
	"os"
	"sync"
)

type Handler struct {
	f *embed.FS
}

var (
	handler *Handler
	once    sync.Once
)

func GetHandler(f *embed.FS) *Handler {
	once.Do(func() {
		handler = &Handler{
			f: f,
		}
	})
	return handler
}

func (h *Handler) Start() {
	isDev := os.Getenv("APP_ENV") == "development"
	router := gin.Default()
	if isDev {
		staticFp := http.Dir("./static")
		router.NoRoute(gin.WrapH(http.FileServer(staticFp)))
	} else {
		// 生产环境使用嵌入的文件系统
		staticFp, err := fs.Sub(h.f, "static")
		if err != nil {
			panic(err)
		}
		router.NoRoute(gin.WrapH(http.FileServer(http.FS(staticFp))))
	}
	api := router.Group("/api")
	api.GET("/emojis", GetEmojis)
	api.GET("/emoji/:id", GetEmoji)
	api.GET("/ping", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"message": "pong",
		})
	})
	log.Logger.Infof("[API] listenning at http://127.0.0.1:8080")
	err := router.Run()
	if err != nil {
		log.Logger.Errorln("[API] start error:", err)
	}
}
