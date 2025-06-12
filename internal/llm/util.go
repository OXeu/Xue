package llm

import "encoding/base64"

func imageToBase64(image []byte) string {
	encoding := base64.StdEncoding
	return "data:image/png;base64," + encoding.EncodeToString(image)
}
