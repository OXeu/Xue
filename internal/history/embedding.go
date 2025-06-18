package history

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/OXeu/Xue/internal/llm"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/utils"
	"github.com/goccy/go-yaml"
	"github.com/philippgille/chromem-go"
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

func GetEmbedding() *Embedding {
	configYaml, err := llm.GetConfigYaml()
	if err != nil {
		panic(err)
	}
	var modelConfigs llm.Config
	err = yaml.Unmarshal(configYaml, &modelConfigs)
	if err != nil {
		panic(err)
	}
	var model llm.OpenAIModel
	for _, modelConfig := range modelConfigs.Models {
		if modelConfig.Ability&llm.EMBEDDING != 0 {
			model = modelConfig
			break
		}
	}
	log.Logger.Infoln("[Embedding] model:", model)
	db, err := chromem.NewPersistentDB("data/chat-history.embedding.db", true)
	if err != nil {
		panic(fmt.Sprintf("Failed to create DB: %v", err))
	}
	collection, _ := db.CreateCollection("chat-history", nil, chromem.NewEmbeddingFuncOpenAICompat(model.BaseUrl, model.Key, model.Model, nil))
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
	err := utils.Bus.Subscribe(utils.ReceiveMsg, e.write)
	if err != nil {
		log.Logger.Errorln("[Embedding] subscribe recv msg error:", err)
		return
	}
}

func (e *Embedding) write(msg *element.Message) {
	err := e.Collection.AddDocument(e.Ctx, chromem.Document{
		ID:      strconv.Itoa(int(msg.ID)),
		Content: msg.JsonContent(),
		Metadata: map[string]string{
			"msg_id":     strconv.Itoa(int(msg.MsgId)),
			"session_id": strconv.Itoa(int(msg.SessionId)),
			"uid":        strconv.Itoa(int(msg.UID)),
		},
	})
	if err != nil {
		log.Logger.Errorln("[Embedding] add document err:", err)
	}
}

func (e *Embedding) RecallMsg(msg *element.Message) ([]element.Message, error) {
	results, err := e.Collection.Query(e.Ctx, msg.JsonContent(), 10, nil, nil)
	if err != nil {
		log.Logger.Errorln("[Embedding] recall query err:", err)
		return nil, err
	}
	messages := make([]element.Message, 0)
	for _, result := range results {
		var recallMsg element.Message
		err := json.Unmarshal([]byte(result.Content), &recallMsg)
		if err != nil {
			log.Logger.Errorln("[Embedding] json unmarshal err:", err)
			continue
		}
		messages = append(messages, recallMsg)
	}
	return messages, nil
}
