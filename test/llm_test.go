package test

import (
	"github.com/OXeu/xue/internal/llm"
	"strings"
	"testing"
)

func TestLLMChat(t *testing.T) {
	response, err := llm.GetLLMManager().Chat(llm.CHAT, "你的名字是 Xue，请牢记你的名字", []llm.Msg{
		{
			Role:    "user",
			Content: "你是谁？",
		},
	}...)
	if err != nil {
		t.Errorf("error: %v", err)
	}
	t.Logf("response: [%s], thinking: [%s]", response.Content, response.ReasoningContent)
	if !strings.Contains(response.Content, "Xue") {
		t.Errorf("response does not contain Xue")
	}
}

func TestLLMThink(t *testing.T) {
	response, err := llm.GetLLMManager().Chat(llm.THINK, "你的名字是 Xue，请牢记你的名字", []llm.Msg{
		{
			Role:    "user",
			Content: "3.11 和 3.8 两个数字哪个大？",
		},
	}...)
	if err != nil {
		t.Errorf("error: %v", err)
	}
	t.Logf("response: [%s]\nthinking: [%s]", response.Content, response.ReasoningContent)
	if len(response.ReasoningContent) == 0 {
		t.Errorf("no reasoning")
	}
}

func TestLLMThinkMig(t *testing.T) {
	response, err := llm.GetLLMManager().Chat(llm.THINK, "你的名字是 Xue，请牢记你的名字", []llm.Msg{
		{
			Role:    "user",
			Content: "3.11 和 3.8 两个数字哪个大？",
		},
	}...)
	if err != nil {
		t.Errorf("error: %v", err)
	}
	t.Logf("response: [%s]\nthinking: [%s]", response.Content, response.ReasoningContent)
	if len(response.ReasoningContent) == 0 {
		t.Errorf("no reasoning")
	}
	responseNew, err := llm.GetLLMManager().Chat(llm.CHAT, "你的名字是 Xue，请牢记你的名字", []llm.Msg{
		{
			Role:    llm.USER,
			Content: "3.11 和 3.8 两个数字哪个大？",
		},
		{
			Role:    llm.ASSIST,
			Content: "思考：" + response.ReasoningContent,
		},
	}...)
	if err != nil {
		t.Errorf("chat error: %v", err)
	}
	t.Logf("迁移后 response: [%s]", responseNew.Content)
}
