package element

import (
	"github.com/OXeu/Xue/internal/utils"
	"io"
	"net/http"
	"os"
)

func (e CustomFaceElement) Prefetch() error {
	if len(e.Id) == 0 {
		md5Name := utils.Md5String(e.Url)
		e.Id = md5Name + ".jpg"
	}
	path, err := utils.Mkdirs("emojis", e.Id)
	if err != nil {
		return err
	}
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
		response, err := http.Get(e.Url)
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

func (e CustomFaceElement) GetImage() ([]byte, error) {
	err := e.Prefetch()
	if err != nil {
		return nil, err
	}
	path, err := utils.Mkdirs("emojis", e.Id)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}
