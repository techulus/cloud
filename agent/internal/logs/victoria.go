package logs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

type VictoriaLogsSender struct {
	endpoint string
	client   *http.Client
}

func NewVictoriaLogsSender(endpoint string) *VictoriaLogsSender {
	return &VictoriaLogsSender{
		endpoint: endpoint,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

type victoriaLogEntry struct {
	Msg          string `json:"_msg"`
	Time         string `json:"_time"`
	DeploymentID string `json:"deployment_id"`
	ServiceID    string `json:"service_id"`
	Stream       string `json:"stream"`
}

func (v *VictoriaLogsSender) SendLogs(batch *LogBatch) error {
	var buf bytes.Buffer
	for _, l := range batch.Logs {
		entry := victoriaLogEntry{
			Msg:          l.Message,
			Time:         l.Timestamp,
			DeploymentID: l.DeploymentID,
			ServiceID:    l.ServiceID,
			Stream:       l.Stream,
		}
		data, err := json.Marshal(entry)
		if err != nil {
			continue
		}
		buf.Write(data)
		buf.WriteByte('\n')
	}

	url := v.endpoint + "/insert/jsonline"
	log.Printf("[logs] sending %d logs (%d bytes) to %s", len(batch.Logs), buf.Len(), url)

	req, err := http.NewRequest("POST", url, &buf)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send logs: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[logs] response: %d in %v", resp.StatusCode, time.Since(start))

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	return nil
}
