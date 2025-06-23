package config

import (
	"errors"
	"github.com/OXeu/Xue/internal/log"
	"github.com/goccy/go-yaml"
	"io"
	"os"
	"sync"
)

const (
	CHAT      = 1      // 聊天模型
	IMAGE     = 1 << 1 // 多模态模型
	TAG       = 1 << 2 // 打标模型
	TOOLCHAIN = 1 << 3 // 工具链调用模型
	THINK     = 1 << 4 // 思考模型
	EMBEDDING = 1 << 5 // 向量模型
)

type Group struct {
	Name string  `yaml:"name"`
	Uin  uint32  `yaml:"uin"`
	Rate float32 `yaml:"rate"`
}

type OpenAIModel struct {
	Name    string `yaml:"name"`
	BaseUrl string `yaml:"base_url"`
	Key     string `yaml:"key"`
	Model   string `yaml:"model"`
	Ability uint8  `yaml:"ability"`
}

type Config struct {
	ThinkMove bool          `yaml:"think_move"`
	Models    []OpenAIModel `yaml:"models"`
	Groups    []Group       `yaml:"groups"`
}

func getConfigYaml() ([]byte, error) {
	openFunc := func(name string) []byte {
		f, err := os.Open(name)
		wd, err := os.Getwd()
		if err != nil {
			return nil
		}
		log.Logger.Infoln("[LLM] finding config file at: " + wd + "/" + name)
		if err != nil {
			return nil
		}
		defer f.Close()
		bytes, err := io.ReadAll(f)
		if err != nil {
			return nil
		}
		return bytes
	}
	tryFileNames := []string{
		"config.yaml",
		"config.yml",
	}
	for _, name := range tryFileNames {
		content := openFunc(name)
		if content != nil {
			return content, nil
		}
	}
	return nil, errors.New("no config file found")
}

var (
	config *Config
	once   sync.Once
)

func GetConfig() *Config {
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
		config = &modelConfigs
	})
	return config
}
