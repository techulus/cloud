package output

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

type Envelope struct {
	OK      bool   `json:"ok"`
	Data    any    `json:"data,omitempty"`
	Summary string `json:"summary,omitempty"`
}

type ErrorEnvelope struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
	Plan  any    `json:"plan,omitempty"`
}

type errorWithPlan interface {
	error
	PlanData() any
}

func JSON(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	return encoder.Encode(value)
}

func OK(w io.Writer, data any, summary string) error {
	return JSON(w, Envelope{OK: true, Data: data, Summary: summary})
}

func Error(w io.Writer, err error) error {
	envelope := ErrorEnvelope{OK: false, Error: err.Error()}
	var planned errorWithPlan
	if errors.As(err, &planned) {
		envelope.Plan = planned.PlanData()
	}
	return JSON(w, envelope)
}

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
