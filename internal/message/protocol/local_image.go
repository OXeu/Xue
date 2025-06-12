package protocol

import (
	"bytes"
	"github.com/LagrangeDev/LagrangeGo/message"
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/utils"
	"go.uber.org/zap"
)

type LocalImage struct {
	Data    []byte `json:"data,omitempty"`
	Source  message.Source
	SubType int32
}

func (l LocalImage) ToLagrangeMessage() message.IMessageElement {
	reader := bytes.NewReader(l.Data)
	image := message.ImageElement{
		Md5:     utils.Md5Bytes(l.Data),
		Sha1:    utils.Sha1Bytes(l.Data),
		Size:    uint32(len(l.Data)),
		Stream:  reader,
		SubType: l.SubType,
	}
	uploadImage, err := GetLagrange().QqClient.UploadImage(l.Source, &image)
	if err != nil {
		log.Error("LocalImage", "upload error", zap.Error(err))
		return nil
	}
	return uploadImage
}
