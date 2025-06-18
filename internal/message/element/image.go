package element

import (
	"github.com/OXeu/Xue/internal/utils"
	"io"
	"net/http"
	"os"
)

func (i *Image) Prefetch() error {
	md5Name := utils.Md5String(i.Url) + ".png"
	path, err := utils.Mkdirs("images", md5Name)
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
		response, err := http.Get(i.Url)
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

func (i *Image) GetImage() ([]byte, error) {
	err := i.Prefetch()
	if err != nil {
		return nil, err
	}
	md5Name := utils.Md5String(i.Url) + ".png"
	path, err := utils.Mkdirs("images", md5Name)
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}
