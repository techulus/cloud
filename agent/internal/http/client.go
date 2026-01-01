package http

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"techulus/cloud-agent/internal/crypto"
)

type Client struct {
	baseURL   string
	serverID  string
	keyPair   *crypto.KeyPair
	client    *http.Client
}

func NewClient(baseURL, serverID string, keyPair *crypto.KeyPair) *Client {
	return &Client{
		baseURL:  baseURL,
		serverID: serverID,
		keyPair:  keyPair,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) signRequest(req *http.Request, body string) {
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 10)
	message := timestamp + ":" + body
	signature := c.keyPair.Sign([]byte(message))

	req.Header.Set("x-server-id", c.serverID)
	req.Header.Set("x-timestamp", timestamp)
	req.Header.Set("x-signature", signature)
}

type PortMapping struct {
	ContainerPort int `json:"containerPort"`
	HostPort      int `json:"hostPort"`
}

type HealthCheck struct {
	Cmd         string `json:"cmd"`
	Interval    int    `json:"interval"`
	Timeout     int    `json:"timeout"`
	Retries     int    `json:"retries"`
	StartPeriod int    `json:"startPeriod"`
}

type VolumeMount struct {
	Name          string `json:"name"`
	HostPath      string `json:"hostPath"`
	ContainerPath string `json:"containerPath"`
}

type ExpectedContainer struct {
	DeploymentID string            `json:"deploymentId"`
	ServiceID    string            `json:"serviceId"`
	ServiceName  string            `json:"serviceName"`
	Name         string            `json:"name"`
	Image        string            `json:"image"`
	IPAddress    string            `json:"ipAddress"`
	Ports        []PortMapping     `json:"ports"`
	Env          map[string]string `json:"env"`
	HealthCheck  *HealthCheck      `json:"healthCheck"`
	Volumes      []VolumeMount     `json:"volumes"`
}

type DnsRecord struct {
	Name string   `json:"name"`
	Ips  []string `json:"ips"`
}

type CaddyRoute struct {
	ID        string   `json:"id"`
	Domain    string   `json:"domain"`
	Upstreams []string `json:"upstreams"`
	ServiceId string   `json:"serviceId"`
}

type WireGuardPeer struct {
	PublicKey  string  `json:"publicKey"`
	AllowedIPs string  `json:"allowedIps"`
	Endpoint   *string `json:"endpoint"`
}

type ExpectedState struct {
	Containers []ExpectedContainer `json:"containers"`
	Dns        struct {
		Records []DnsRecord `json:"records"`
	} `json:"dns"`
	Caddy struct {
		Routes []CaddyRoute `json:"routes"`
	} `json:"caddy"`
	Wireguard struct {
		Peers []WireGuardPeer `json:"peers"`
	} `json:"wireguard"`
}

func (c *Client) GetExpectedState() (*ExpectedState, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/api/v1/agent/expected-state", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	c.signRequest(req, "")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch expected state: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("expected state request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var state ExpectedState
	if err := json.NewDecoder(resp.Body).Decode(&state); err != nil {
		return nil, fmt.Errorf("failed to decode expected state: %w", err)
	}

	return &state, nil
}

type ContainerStatus struct {
	DeploymentID string `json:"deploymentId"`
	ContainerID  string `json:"containerId"`
	Status       string `json:"status"`
	HealthStatus string `json:"healthStatus"`
}

type Resources struct {
	CpuCores int `json:"cpuCores"`
	MemoryMb int `json:"memoryMb"`
	DiskGb   int `json:"diskGb"`
}

type StatusReport struct {
	Resources  *Resources        `json:"resources,omitempty"`
	PublicIP   string            `json:"publicIp,omitempty"`
	Containers []ContainerStatus `json:"containers"`
}

func (c *Client) ReportStatus(report *StatusReport) error {
	body, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("failed to marshal status report: %w", err)
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/agent/status", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, string(body))

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to report status: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("status report failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}
