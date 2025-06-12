package llm

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/OXeu/Xue/internal/log"
	"github.com/goccy/go-yaml"
	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/sirupsen/logrus"
	"strings"
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
		configYaml, err := GetConfigYaml()
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
			if len(prompt) != 0 {
				msgUnions = append(msgUnions, openai.SystemMessage(prompt))
			}
			for _, m := range msg {
				msgUnions = append(msgUnions, m.ToLLM())
			}
			if log.Logger.Level >= logrus.DebugLevel {
				marshal, err := json.Marshal(msgUnions)
				if err != nil {
					return nil, err
				}
				log.Logger.Debugln("[Chat] request chat:", string(marshal))
			}
			chatCompletion, err := model.Client.Chat.Completions.New(context.Background(), openai.ChatCompletionNewParams{
				Messages: msgUnions,
				Model:    model.Model,
			})
			if err != nil {
				log.Logger.Errorln("[Chat] request chat error:", err)
				continue
			}
			var respNew Response
			resp := chatCompletion.Choices[0].Message
			err = json.Unmarshal([]byte(resp.RawJSON()), &respNew)
			if err != nil {
				log.Logger.Errorln("[Chat] unmarshal Error:", err)
				return nil, err
			}
			if len(respNew.ReasoningContent) == 0 && strings.Contains(respNew.Content, "<think>") {
				r := strings.Split(respNew.Content, "</think>")
				respNew.ReasoningContent = strings.TrimSpace(strings.TrimPrefix(r[0], "<think>"))
				respNew.Content = strings.TrimSpace(r[1])
			}
			return &respNew, nil
		}
	}
	return nil, errors.New("no model available")
}
