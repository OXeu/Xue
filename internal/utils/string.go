package utils

import "strings"

func SubString(s, start, end string) string {
	st := strings.Index(s, start)
	ed := strings.Index(s, end)
	if st != -1 && ed != -1 {
		s = s[st+len(start) : ed]
	} else if st != -1 {
		s = s[st+len(start):]
	} else if ed != -1 {
		s = s[:ed]
	}
	return s
}
