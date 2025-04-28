package llm

import "github.com/openai/openai-go"

const (
	USER   = "user"
	ASSIST = "assistant"
	SYSTEM = "system"
)

type Msg struct {
	Role    string
	Content string
	Image   []byte
}

type Response struct {
	Content          string `json:"content,omitempty"`
	ReasoningContent string `json:"reasoning_content,omitempty"`
}

func (m *Msg) ToLLM() openai.ChatCompletionMessageParamUnion {
	var messages []openai.ChatCompletionContentPartUnionParam
	if m.Image != nil {
		messages = []openai.ChatCompletionContentPartUnionParam{{
			OfImageURL: &openai.ChatCompletionContentPartImageParam{
				ImageURL: openai.ChatCompletionContentPartImageImageURLParam{
					URL: imageToBase64(m.Image),
				},
			},
		}, {
			OfText: &openai.ChatCompletionContentPartTextParam{
				Text: m.Content,
			},
		},
		}
	} else {
		messages = []openai.ChatCompletionContentPartUnionParam{{
			OfText: &openai.ChatCompletionContentPartTextParam{
				Text: m.Content,
			},
		},
		}
	}
	switch m.Role {
	case "system":
		return openai.SystemMessage(m.Content)
	case "user":
		return openai.UserMessage(messages)
	case "assistant":
		return openai.AssistantMessage(m.Content)
	default:
		return openai.UserMessage(messages)
	}
}
