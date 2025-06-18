package element

import (
	"github.com/OXeu/Xue/internal/utils"
	"io"
	"net/http"
	"os"
)

func (i *Image) Prefetch() error {
	if len(i.Id) == 0 {
		md5Name := utils.Md5String(i.Url)
		i.Id = md5Name + ".jpg"
	}
	path, err := utils.Mkdirs("images", i.Id)
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
	if len(i.Id) == 0 {
		md5Name := utils.Md5String(i.Url)
		i.Id = md5Name + ".jpg"
	}
	path, err := utils.Mkdirs("images", i.Id)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}
