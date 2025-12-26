package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	baseURL string
	http    *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

type RegisterRequest struct {
	Token              string `json:"token"`
	WireGuardPublicKey string `json:"wireguardPublicKey"`
	SigningPublicKey   string `json:"signingPublicKey"`
	PublicIP           string `json:"publicIp,omitempty"`
}

type RegisterResponse struct {
	ServerID    string `json:"serverId"`
	WireGuardIP string `json:"wireguardIp"`
	Peers       []Peer `json:"peers"`
}

type Peer struct {
	PublicKey  string  `json:"publicKey"`
	AllowedIPs string  `json:"allowedIps"`
	Endpoint   *string `json:"endpoint"`
}

func (c *Client) Register(token, wireguardPublicKey, signingPublicKey, publicIP string) (*RegisterResponse, error) {
	req := RegisterRequest{
		Token:              token,
		WireGuardPublicKey: wireguardPublicKey,
		SigningPublicKey:   signingPublicKey,
		PublicIP:           publicIP,
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	resp, err := c.http.Post(c.baseURL+"/api/v1/agent/register", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("registration failed: %s (status %d)", string(respBody), resp.StatusCode)
	}

	var result RegisterResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &result, nil
}
