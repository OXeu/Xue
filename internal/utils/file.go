package utils

import (
	"errors"
	"os"
	"path"
)

func FileExists(filePath string) (bool, error) {
	info, err := os.Stat(filePath)
	if err == nil {
		return !info.IsDir(), nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func Mkdirs(args ...string) (string, error) {
	length := len(args)
	parentArr := args[0 : length-1]
	name := args[length-1]
	parent := path.Join("data", path.Join(parentArr...))
	if err := os.MkdirAll(parent, 0755); err != nil {
		return "", err
	}
	return path.Join(parent, name), nil
}

func ReadFrom(folder, name string) ([]byte, error) {
	p := path.Join("data", folder, name)
	return os.ReadFile(p)
}
