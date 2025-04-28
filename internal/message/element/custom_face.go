package element

import (
	"github.com/OXeu/xue/internal/utils"
	"io"
	"net/http"
	"os"
)

func (emojiMsg *CustomFaceElement) Prefetch() error {
	md5Name := utils.Md5String(emojiMsg.Url)
	path := "data/" + md5Name + ".png"
	exists, err := utils.FileExists(path)
	if err != nil {
		return err
	}
	if !exists {
		file, err := os.Create(path)
		if err != nil {
			return err
		}
		// 下载
		response, err := http.Get(emojiMsg.Url)
		if err != nil {
			return err
		}
		_, err = io.Copy(file, response.Body)
		if err != nil {
			return err
		}
		_ = response.Body.Close()
		_ = file.Close()
	}
	return nil
}

func (emojiMsg *CustomFaceElement) GetImage() ([]byte, error) {
	err := emojiMsg.Prefetch()
	if err != nil {
		return nil, err
	}
	md5Name := utils.Md5String(emojiMsg.Url)
	path := "data/" + md5Name + "png"
	file, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}
