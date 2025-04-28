package llm

import (
	"errors"
	"github.com/OXeu/xue/internal/log"
	"io"
	"os"
)

const (
	CHAT      = 1      // 聊天模型
	IMAGE     = 1 << 1 // 多模态模型
	TAG       = 1 << 2 // 打标模型
	TOOLCHAIN = 1 << 3 // 工具链调用模型
	THINK     = 1 << 4 // 思考模型
	EMBEDDING = 1 << 5 // 向量模型
)

type OpenAIModel struct {
	Name    string `yaml:"name"`
	BaseUrl string `yaml:"base_url"`
	Key     string `yaml:"key"`
	Model   string `yaml:"model"`
	Ability uint8  `yaml:"ability"`
}

type Config struct {
	Models []OpenAIModel `yaml:"models"`
}

func getConfigYaml() ([]byte, error) {
	openFunc := func(name string) []byte {
		f, err := os.Open(name)
		wd, err := os.Getwd()
		if err != nil {
			return nil
		}
		log.Info("LLM", "finding config file at: "+wd+"/"+name)
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
