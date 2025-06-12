package utils

import (
	"crypto/md5"
	"crypto/sha1"
	"encoding/hex"
)

func Md5String(s string) string {
	h := md5.New()
	h.Write([]byte(s))
	return hex.EncodeToString(h.Sum(nil))
}

func Md5Bytes(b []byte) []byte {
	h := md5.New()
	h.Write(b)
	return h.Sum(nil)
}

func Sha1Bytes(b []byte) []byte {
	h := sha1.New()
	h.Write(b)
	return h.Sum(nil)
}
