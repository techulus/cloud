package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/techulus/cloud-agent/internal/crypto"
)

type Client struct {
	baseURL  string
	serverID string
	keyPair  *crypto.KeyPair
	http     *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) SetServerID(id string) {
	c.serverID = id
}

func (c *Client) SetKeyPair(kp *crypto.KeyPair) {
	c.keyPair = kp
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

type StatusRequest struct {
	Resources  *Resources       `json:"resources,omitempty"`
	PublicIP   string           `json:"publicIp,omitempty"`
	Containers []ContainerInfo  `json:"containers,omitempty"`
}

type Resources struct {
	CPU    int `json:"cpu,omitempty"`
	Memory int `json:"memory,omitempty"`
	Disk   int `json:"disk,omitempty"`
}

type ContainerInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Image   string `json:"image"`
	State   string `json:"state"`
	Created int64  `json:"created"`
}

type StatusResponse struct {
	Work *Work `json:"work"`
}

type Work struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func (c *Client) SendStatus(resources *Resources, publicIP string, containers []ContainerInfo) (*StatusResponse, error) {
	if c.keyPair == nil || c.serverID == "" {
		return nil, fmt.Errorf("client not configured with server ID and key pair")
	}

	req := StatusRequest{
		Resources:  resources,
		PublicIP:   publicIP,
		Containers: containers,
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	message := timestamp + ":" + string(body)
	signature := c.keyPair.Sign([]byte(message))

	httpReq, err := http.NewRequest("POST", c.baseURL+"/api/v1/agent/status", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Server-ID", c.serverID)
	httpReq.Header.Set("X-Timestamp", timestamp)
	httpReq.Header.Set("X-Signature", signature)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status request failed: %s (status %d)", string(respBody), resp.StatusCode)
	}

	var result StatusResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &result, nil
}

type CompleteRequest struct {
	Status string `json:"status"`
	Logs   string `json:"logs,omitempty"`
}

func (c *Client) CompleteWork(workID, status, logs string) error {
	if c.keyPair == nil || c.serverID == "" {
		return fmt.Errorf("client not configured with server ID and key pair")
	}

	req := CompleteRequest{
		Status: status,
		Logs:   logs,
	}

	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	message := timestamp + ":" + string(body)
	signature := c.keyPair.Sign([]byte(message))

	url := fmt.Sprintf("%s/api/v1/agent/work/%s/complete", c.baseURL, workID)
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Server-ID", c.serverID)
	httpReq.Header.Set("X-Timestamp", timestamp)
	httpReq.Header.Set("X-Signature", signature)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("complete request failed: %s (status %d)", string(respBody), resp.StatusCode)
	}

	return nil
}
