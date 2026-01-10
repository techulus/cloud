package http

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"techulus/cloud-agent/internal/crypto"
)

type Client struct {
	baseURL   string
	serverID  string
	keyPair   *crypto.KeyPair
	client    *http.Client
	dataDir   string
}

func NewClient(baseURL, serverID string, keyPair *crypto.KeyPair, dataDir string) *Client {
	return &Client{
		baseURL:  baseURL,
		serverID: serverID,
		keyPair:  keyPair,
		dataDir:  dataDir,
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

const expectedStateCacheFile = "expected-state.json"

func (c *Client) cacheExpectedState(state *ExpectedState) error {
	if c.dataDir == "" {
		return nil
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(c.dataDir, expectedStateCacheFile)
	return os.WriteFile(path, data, 0600)
}

func (c *Client) loadCachedExpectedState() (*ExpectedState, error) {
	if c.dataDir == "" {
		return nil, fmt.Errorf("data dir not configured")
	}
	path := filepath.Join(c.dataDir, expectedStateCacheFile)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var state ExpectedState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (c *Client) getExpectedState() (*ExpectedState, error) {
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

	if err := c.cacheExpectedState(&state); err != nil {
		log.Printf("[cache] failed to cache expected state: %v", err)
	}

	return &state, nil
}

func (c *Client) GetExpectedStateWithFallback() (*ExpectedState, bool, error) {
	state, err := c.getExpectedState()
	if err == nil {
		return state, false, nil
	}

	log.Printf("[state] CP unreachable, attempting to use cached state: %v", err)
	cachedState, cacheErr := c.loadCachedExpectedState()
	if cacheErr != nil {
		return nil, false, fmt.Errorf("CP unreachable and no cached state available: %w (cache error: %v)", err, cacheErr)
	}

	return cachedState, true, nil
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
	PrivateIP  string            `json:"privateIp,omitempty"`
	Meta       map[string]string `json:"meta,omitempty"`
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

type BuildDetails struct {
	Build struct {
		ID            string `json:"id"`
		CommitSha     string `json:"commitSha"`
		CommitMessage string `json:"commitMessage"`
		Branch        string `json:"branch"`
		ServiceID     string `json:"serviceId"`
		ProjectID     string `json:"projectId"`
	} `json:"build"`
	CloneURL       string            `json:"cloneUrl"`
	ImageURI       string            `json:"imageUri"`
	RootDir        string            `json:"rootDir"`
	Secrets        map[string]string `json:"secrets"`
	TimeoutMinutes int               `json:"timeoutMinutes"`
}

func (c *Client) GetBuild(buildID string) (*BuildDetails, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/api/v1/agent/builds/"+buildID, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	c.signRequest(req, "")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get build: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("get build failed with status %d: %s", resp.StatusCode, string(body))
	}

	var result BuildDetails
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode build: %w", err)
	}

	return &result, nil
}

func (c *Client) UpdateBuildStatus(buildID, status, errorMsg string) error {
	payload := map[string]string{
		"status": status,
	}
	if errorMsg != "" {
		payload["error"] = errorMsg
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal status update: %w", err)
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/agent/builds/"+buildID+"/status", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, string(body))

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to update build status: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("build status update failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

type WorkQueueItem struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Payload string `json:"payload"`
}

func (c *Client) GetWorkQueue() ([]WorkQueueItem, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/api/v1/agent/work-queue", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	c.signRequest(req, "")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch work queue: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("work queue request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Items []WorkQueueItem `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode work queue: %w", err)
	}

	return result.Items, nil
}

func (c *Client) CompleteWorkItem(id, status, errorMsg string) error {
	payload := map[string]string{
		"id":     id,
		"status": status,
	}
	if errorMsg != "" {
		payload["error"] = errorMsg
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal work item update: %w", err)
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/agent/work-queue", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, string(body))

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to complete work item: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("work item update failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

func (c *Client) GetBuildStatus(buildID string) (string, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/api/v1/agent/builds/"+buildID+"/status", nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	c.signRequest(req, "")

	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to get build status: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("get build status failed with status %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode build status: %w", err)
	}

	return result.Status, nil
}
