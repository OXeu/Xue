package history

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/utils"
	"github.com/philippgille/chromem-go"
	"go.uber.org/zap"
	"strconv"
	"sync"
)

// 向量化聊天消息

type Embedding struct {
	Ctx        context.Context
	Db         *chromem.DB
	Collection *chromem.Collection
}

var embedding *Embedding
var embeddingOnce sync.Once

const (
	baseUrl        = "https://ollama.xeu.sh/api"
	embeddingModel = "smartcreation/bge-large-zh-v1.5:latest"
)

func GetEmbedding() *Embedding {
	db, err := chromem.NewPersistentDB("data/chat-history.embedding.db", true)
	if err != nil {
		panic(fmt.Sprintf("Failed to create DB: %v", err))
	}
	collection, _ := db.CreateCollection("chat-history", nil, chromem.NewEmbeddingFuncOllama(embeddingModel, baseUrl))
	embeddingOnce.Do(func() {
		embedding = &Embedding{
			Ctx:        context.Background(),
			Db:         db,
			Collection: collection,
		}
	})
	return embedding
}

func (e *Embedding) Start() {
	err := utils.Bus.Subscribe(utils.RECV_MSG, e.write)
	if err != nil {
		log.Error("Embedding", "subscribe recv msg error", zap.Error(err))
		return
	}
}

func (e Embedding) write(msg *element.Message) {
	err := e.Collection.AddDocument(e.Ctx, chromem.Document{
		ID:      strconv.Itoa(int(msg.ID)),
		Content: msg.JsonContent(),
		Metadata: map[string]string{
			"msg_id": strconv.Itoa(int(msg.MsgId)),
			"gid":    strconv.Itoa(int(msg.GID)),
			"uid":    strconv.Itoa(int(msg.UID)),
		},
	})
	if err != nil {
		log.Error("Embedding", "add document err", zap.Error(err))
	}
}

func (e Embedding) RecallMsg(msg *element.Message) ([]element.Message, error) {
	results, err := e.Collection.Query(e.Ctx, msg.JsonContent(), 10, nil, nil)
	if err != nil {
		log.Error("Embedding", "recall query err", zap.Error(err))
		return nil, err
	}
	messages := make([]element.Message, 0)
	for _, result := range results {
		var recallMsg element.Message
		err := json.Unmarshal([]byte(result.Content), &recallMsg)
		if err != nil {
			log.Error("Embedding", "json unmarshal err", zap.Error(err))
			continue
		}
		messages = append(messages, recallMsg)
	}
	return messages, nil
}
