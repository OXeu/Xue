package api

import "testing"

func TestGetEmojis(t *testing.T) {
	GetHandler(nil).Start()
}
