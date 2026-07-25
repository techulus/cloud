package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	Host       string
	APIKey     string
	HTTPClient *http.Client
}

type ErrorResponse struct {
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
	Code    string `json:"code,omitempty"`
}

type APIError struct {
	Status  int
	Message string
	Code    string
	Host    string
}

func (e *APIError) Error() string {
	message := e.Message
	if message == "" {
		message = fmt.Sprintf("Request failed with %d", e.Status)
	}
	if e.Code != "" {
		message += fmt.Sprintf(" (%s)", e.Code)
	}
	if e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden {
		message += fmt.Sprintf("\n\nYour CLI session is not authorized. Run:\n  tc auth login --host %s", e.Host)
	}
	return message
}

func NormalizeHost(host string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(host), "/")
	if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") {
		return "https://" + trimmed
	}
	return trimmed
}

func NewClient(host, apiKey string) *Client {
	return &Client{
		Host:   NormalizeHost(host),
		APIKey: apiKey,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) RequestJSON(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	endpoint := c.Host + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	headers := map[string]string{}
	if c.APIKey != "" {
		headers["x-api-key"] = c.APIKey
	}
	return JSON(ctx, c.HTTPClient, method, endpoint, headers, body, out)
}

func requestJSON(ctx context.Context, client *http.Client, method, endpoint string, headers map[string]string, body any) (int, []byte, error) {
	if client == nil {
		client = http.DefaultClient
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("content-type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	return resp.StatusCode, raw, err
}

func JSON(ctx context.Context, client *http.Client, method, endpoint string, headers map[string]string, body any, out any) error {
	status, raw, err := requestJSON(ctx, client, method, endpoint, headers, body)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		var apiErr ErrorResponse
		_ = json.Unmarshal(raw, &apiErr)
		message := apiErr.Message
		if message == "" {
			message = apiErr.Error
		}
		parsed, _ := url.Parse(endpoint)
		host := ""
		if parsed != nil {
			host = NormalizeHost(parsed.Scheme + "://" + parsed.Host)
		}
		return &APIError{
			Status:  status,
			Message: message,
			Code:    apiErr.Code,
			Host:    host,
		}
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("invalid JSON response: %w", err)
	}
	return nil
}

func JSONStatus(ctx context.Context, client *http.Client, method, endpoint string, body any, out any) (int, error) {
	status, raw, err := requestJSON(ctx, client, method, endpoint, nil, body)
	if err != nil {
		return status, err
	}
	if len(raw) > 0 && out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return status, fmt.Errorf("invalid JSON response: %w", err)
		}
	}
	return status, nil
}
