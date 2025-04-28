package llm

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/OXeu/xue/internal/log"
	"github.com/goccy/go-yaml"
	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"go.uber.org/zap"
	"sync"
)

// LLM 交互处理器

type Model struct {
	Client  openai.Client
	Model   string
	Ability uint8
}

type Manager struct {
	Models []Model // 思考模型
}

var (
	once     sync.Once
	instance *Manager
)

func GetLLMManager() *Manager {
	once.Do(func() {
		configYaml, err := getConfigYaml()
		if err != nil {
			panic(err)
		}
		var modelConfigs Config
		err = yaml.Unmarshal(configYaml, &modelConfigs)
		if err != nil {
			panic(err)
		}
		var models []Model
		for _, modelConfig := range modelConfigs.Models {
			models = append(models, Model{
				Ability: modelConfig.Ability,
				Client:  openai.NewClient(option.WithBaseURL(modelConfig.BaseUrl), option.WithAPIKey(modelConfig.Key)),
				Model:   modelConfig.Model,
			})
		}
		instance = &Manager{
			Models: models,
		}
	})
	return instance
}

func (m *Manager) Chat(ability uint8, prompt string, msg ...Msg) (*Response, error) {
	for _, model := range m.Models {
		if model.Ability&ability != 0 {
			var msgUnions []openai.ChatCompletionMessageParamUnion
			msgUnions = append(msgUnions, openai.SystemMessage(prompt))
			for _, m := range msg {
				msgUnions = append(msgUnions, m.ToLLM())
			}
			chatCompletion, err := model.Client.Chat.Completions.New(context.Background(), openai.ChatCompletionNewParams{
				Messages: msgUnions,
				Model:    model.Model,
			})
			if err != nil {
				log.Error("Chat", "request chat error", zap.Error(err))
				continue
			}
			var respNew Response
			resp := chatCompletion.Choices[0].Message
			err = json.Unmarshal([]byte(resp.RawJSON()), &respNew)
			if err != nil {
				log.Error("Chat", "unmarshal Error", zap.Error(err))
				return nil, err
			}
			return &respNew, nil
		}
	}
	return nil, errors.New("no model available")
}
