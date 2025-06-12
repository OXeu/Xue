package utils

import "time"

func GetLocation() *time.Location {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		panic(err)
	}
	return shanghai
}
