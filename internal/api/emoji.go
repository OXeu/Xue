package api

import (
	"github.com/OXeu/Xue/internal/face"
	"github.com/OXeu/Xue/internal/log"
	"github.com/gin-gonic/gin"
)

func GetEmojis(g *gin.Context) {
	faces := face.GetFaceManager().GetAllFaces()
	g.JSON(200, gin.H{
		"emojis": faces,
	})
}

func GetEmoji(g *gin.Context) {
	id := g.Param("id")
	f := face.GetFaceManager().GetFace(id)
	if len(f.Id) > 0 {
		image, err := f.GetImage()
		if err != nil {
			log.Logger.Error("[GetEmoji]", "get image failed: ", err)
			g.JSON(404, gin.H{
				"err": "image get error",
			})
			return
		}
		g.Data(200, "image/png", image)
	} else {
		g.JSON(404, gin.H{
			"err": "image not found",
		})
	}
}
