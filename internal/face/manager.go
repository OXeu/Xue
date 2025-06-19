package face

import (
	"github.com/OXeu/Xue/internal/log"
	"github.com/OXeu/Xue/internal/message/element"
	"github.com/OXeu/Xue/internal/utils"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	path2 "path"
	"sync"
)

type Manager struct {
	Db *gorm.DB
}

var (
	once     sync.Once
	instance *Manager
)

func GetFaceManager() *Manager {
	once.Do(func() {
		db, err := gorm.Open(sqlite.Open(path2.Join("data", "emojis.db")), &gorm.Config{})
		if err != nil {
			if err != nil {
				log.Logger.Errorln("[FaceManager] failed to connect database:", err)
			}
		}
		err = db.AutoMigrate(&element.CustomFaceElement{})
		if err != nil {
			log.Logger.Errorln("[FaceManager] failed to migrate:", err)
		}
		instance = &Manager{
			Db: db,
		}
	})
	return instance
}

func (m Manager) Start() {
	log.Logger.Infoln("[FaceManager]", "start")
	go func() {
		err := utils.Bus.Subscribe(utils.ReceiveEmoji, m.ReceiveFace)
		if err != nil {
			log.Logger.Error("[FaceManager]", "subscribe RECV_EMOJI error", err)
		}
	}()
	err := utils.Bus.Subscribe(utils.LabeledEmoji, m.SaveFace)
	if err != nil {
		log.Logger.Error("[FaceManager]", "subscribe LABELED_EMOJI error", err)
	}
}

func (m Manager) ReceiveFace(msg *element.CustomFaceElement) {
	log.Logger.Infoln("[FaceManager] received face: \"", msg.Label, "\", ", msg.Md5)
	err := msg.Prefetch()
	if !m.IsFaceExist(msg) {
		m.Db.Create(&msg)
	}
	if err != nil {
		log.Logger.Error("[FaceManager] save error: ", err)
		return
	}
	image, err := msg.GetImage()
	if err != nil {
		log.Logger.Error("[FaceManager]", "get image error: ", err)
	}
	utils.Bus.Publish(utils.LabelEmoji, msg.Id, image, "emoji")
}

func (m Manager) SaveFace(id, label string) {
	msg := m.GetFace(id)
	msg.Label = label
	m.Db.Model(&element.CustomFaceElement{}).Where("id = ?", id).Update("label", label)
	log.Logger.Infoln("[FaceManager]", "saved face label", msg.Label, " -> ", msg.Md5)
}

func (m Manager) GetLabeledFaces() []element.CustomFaceElement {
	var faces []element.CustomFaceElement
	m.Db.Where("label != ''").Find(&faces)
	log.Logger.Infoln("[FaceManager]", "get faces", len(faces))
	for _, face := range faces {
		log.Logger.Infoln("[FaceManager]", "face", face.Label, face.Id)
	}
	return faces
}

func (m Manager) GetAllFaces() []element.CustomFaceElement {
	var faces []element.CustomFaceElement
	m.Db.Find(&faces)
	log.Logger.Infoln("[FaceManager]", "get all faces", len(faces))
	for _, face := range faces {
		log.Logger.Infoln("[FaceManager]", "face", face.Label, face.Id)
	}
	return faces
}

func (m Manager) GetUnlabeledFaces() []element.CustomFaceElement {
	var faces []element.CustomFaceElement
	m.Db.Where("label = ''").Find(&faces)
	log.Logger.Infoln("[FaceManager]", "get faces", len(faces))
	for _, face := range faces {
		log.Logger.Infoln("[FaceManager]", "face", face.Label, face.Id)
	}
	return faces
}

func (m Manager) GetFace(id string) element.CustomFaceElement {
	var face element.CustomFaceElement
	m.Db.Where("id = ?", id).Find(&face)
	return face
}

func (m Manager) IsFaceExist(msg *element.CustomFaceElement) bool {
	var dest element.CustomFaceElement
	m.Db.First(&dest, "md5 = ?", msg.Md5)
	return len(dest.Id) > 0
}
