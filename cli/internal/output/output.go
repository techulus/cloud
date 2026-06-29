package output

import (
	"fmt"
	"io"
	"strings"
	"time"
)

func Section(w io.Writer, title string) {
	fmt.Fprintf(w, "\n%s\n%s\n", title, strings.Repeat("-", len(title)))
}

func Field(w io.Writer, label string, value any) {
	fmt.Fprintf(w, "  %-10s %v\n", label, value)
}

func Next(w io.Writer, command string) {
	Section(w, "Next")
	Field(w, "Run", command)
}

func ShortID(id string) string {
	if len(id) <= 16 {
		return id
	}
	return id[:8] + "..." + id[len(id)-4:]
}

func Status(value string) string {
	return strings.ReplaceAll(value, "_", " ")
}

func Timestamp(value string) string {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return value
	}
	return parsed.UTC().Format(time.RFC3339Nano)
}
