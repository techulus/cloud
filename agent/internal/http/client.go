package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"techulus/cloud-agent/internal/crypto"
	"techulus/cloud-agent/internal/health"
)

type Client struct {
	baseURL                string
	serverID               string
	keyPair                *crypto.KeyPair
	client                 *http.Client
	longClient             *http.Client
	dataDir                string
	upgradeLogMutex        sync.Mutex
	lastUpgradeRequiredLog time.Time
}

type UpgradeRequiredError struct {
	Message string
}

func (e *UpgradeRequiredError) Error() string {
	return fmt.Sprintf("agent upgrade required: %s", e.Message)
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
		longClient: &http.Client{
			Timeout: 40 * time.Second,
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
	DeploymentID          string            `json:"deploymentId"`
	RevisionID            string            `json:"revisionId"`
	ContainerSpecHash     string            `json:"containerSpecHash"`
	ServiceID             string            `json:"serviceId"`
	ServiceName           string            `json:"serviceName"`
	Name                  string            `json:"name"`
	DesiredState          string            `json:"desiredState"`
	Image                 string            `json:"image"`
	IPAddress             string            `json:"ipAddress"`
	Ports                 []PortMapping     `json:"ports"`
	PublishLocalPorts     bool              `json:"publishLocalPorts"`
	Env                   map[string]string `json:"env"`
	StartCommand          string            `json:"startCommand"`
	HealthCheck           *HealthCheck      `json:"healthCheck"`
	Volumes               []VolumeMount     `json:"volumes"`
	ResourceCPULimit      *float64          `json:"resourceCpuLimit"`
	ResourceMemoryLimitMb *int              `json:"resourceMemoryLimitMb"`
}

type DnsRecord struct {
	Name string   `json:"name"`
	Ips  []string `json:"ips"`
}

type Upstream struct {
	Url    string `json:"url"`
	Weight int    `json:"weight"`
}

type ServerlessUpstream struct {
	DeploymentID string `json:"deploymentId"`
	ServerID     string `json:"serverId"`
	Url          string `json:"url"`
	Local        bool   `json:"local"`
	AlwaysOn     bool   `json:"alwaysOn"`
}

type ServerlessRoute struct {
	ServiceID          string               `json:"serviceId"`
	Domain             string               `json:"domain"`
	Port               int                  `json:"port"`
	SleepAfterSeconds  int                  `json:"sleepAfterSeconds"`
	WakeTimeoutSeconds int                  `json:"wakeTimeoutSeconds"`
	LocalDeploymentIDs []string             `json:"localDeploymentIds"`
	Upstreams          []ServerlessUpstream `json:"upstreams"`
}

type TraefikRoute struct {
	ID        string     `json:"id"`
	Domain    string     `json:"domain"`
	Upstreams []Upstream `json:"upstreams"`
	ServiceId string     `json:"serviceId"`
}

type TraefikTCPRoute struct {
	ID             string   `json:"id"`
	ServiceId      string   `json:"serviceId"`
	Upstreams      []string `json:"upstreams"`
	ExternalPort   int      `json:"externalPort"`
	TLSPassthrough bool     `json:"tlsPassthrough"`
}

type TraefikUDPRoute struct {
	ID           string   `json:"id"`
	ServiceId    string   `json:"serviceId"`
	Upstreams    []string `json:"upstreams"`
	ExternalPort int      `json:"externalPort"`
}

type Certificate struct {
	Domain         string `json:"domain"`
	Certificate    string `json:"certificate"`
	CertificateKey string `json:"certificateKey"`
}

type ChallengeRouteConfig struct {
	ControlPlaneUrl string `json:"controlPlaneUrl"`
}

type WireGuardPeer struct {
	PublicKey  string  `json:"publicKey"`
	AllowedIPs string  `json:"allowedIps"`
	Endpoint   *string `json:"endpoint"`
}

type ExpectedState struct {
	SchemaVersion int                 `json:"schemaVersion"`
	ServerName    string              `json:"serverName"`
	Containers    []ExpectedContainer `json:"containers"`
	Dns           struct {
		Records []DnsRecord `json:"records"`
	} `json:"dns"`
	Serverless struct {
		Routes []ServerlessRoute `json:"routes"`
	} `json:"serverless"`
	Traefik struct {
		HttpRoutes     []TraefikRoute        `json:"httpRoutes"`
		TCPRoutes      []TraefikTCPRoute     `json:"tcpRoutes"`
		UDPRoutes      []TraefikUDPRoute     `json:"udpRoutes"`
		Certificates   []Certificate         `json:"certificates,omitempty"`
		ChallengeRoute *ChallengeRouteConfig `json:"challengeRoute,omitempty"`
	} `json:"traefik"`
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
	if err := validateExpectedState(&state); err != nil {
		return nil, fmt.Errorf("cached expected state is invalid: %w", err)
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
		if resp.StatusCode == http.StatusUpgradeRequired {
			return nil, &UpgradeRequiredError{Message: string(body)}
		}
		return nil, fmt.Errorf("expected state request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var state ExpectedState
	if err := json.NewDecoder(resp.Body).Decode(&state); err != nil {
		return nil, fmt.Errorf("failed to decode expected state: %w", err)
	}
	if err := validateExpectedState(&state); err != nil {
		return nil, err
	}

	if err := c.cacheExpectedState(&state); err != nil {
		log.Printf("[cache] failed to cache expected state: %v", err)
	}

	return &state, nil
}

func validateExpectedState(state *ExpectedState) error {
	if state.SchemaVersion != 1 {
		return fmt.Errorf("unsupported expected state schema version %d", state.SchemaVersion)
	}
	for _, expectedContainer := range state.Containers {
		if expectedContainer.DeploymentID == "" {
			return fmt.Errorf("expected container is missing deploymentId")
		}
		if expectedContainer.RevisionID == "" {
			return fmt.Errorf("expected container %s is missing revisionId", expectedContainer.DeploymentID)
		}
		if expectedContainer.ContainerSpecHash == "" {
			return fmt.Errorf("expected container %s is missing containerSpecHash", expectedContainer.DeploymentID)
		}
	}
	return nil
}

func (c *Client) GetExpectedStateWithFallback() (*ExpectedState, bool, error) {
	state, err := c.getExpectedState()
	if err == nil {
		return state, false, nil
	}

	var upgradeRequired *UpgradeRequiredError
	if errors.As(err, &upgradeRequired) {
		if c.shouldLogUpgradeRequired() {
			log.Printf("[state] UPGRADE REQUIRED: control plane rejected this agent; serving cached state until upgraded: %v", err)
		}
	} else {
		log.Printf("[state] CP unreachable, attempting to use cached state: %v", err)
	}
	cachedState, cacheErr := c.loadCachedExpectedState()
	if cacheErr != nil {
		return nil, false, fmt.Errorf("CP unreachable and no cached state available: %w (cache error: %v)", err, cacheErr)
	}

	return cachedState, true, nil
}

func (c *Client) shouldLogUpgradeRequired() bool {
	c.upgradeLogMutex.Lock()
	defer c.upgradeLogMutex.Unlock()
	if time.Since(c.lastUpgradeRequiredLog) < time.Minute {
		return false
	}
	c.lastUpgradeRequiredLog = time.Now()
	return true
}

type ContainerStatus struct {
	DeploymentID string `json:"deploymentId"`
	ContainerID  string `json:"containerId"`
	Status       string `json:"status"`
	HealthStatus string `json:"healthStatus"`
}

type DeploymentError struct {
	DeploymentID string `json:"deploymentId"`
	Message      string `json:"message"`
}

type Resources struct {
	CpuCores int `json:"cpuCores"`
	MemoryMb int `json:"memoryMb"`
	DiskGb   int `json:"diskGb"`
}

type AgentHealth struct {
	Version                string                  `json:"version"`
	UptimeSecs             int64                   `json:"uptimeSecs"`
	Capabilities           []string                `json:"capabilities,omitempty"`
	ReconciliationFailures []ReconciliationFailure `json:"reconciliationFailures,omitempty"`
}

type ReconciliationFailure struct {
	Action       string    `json:"action"`
	DeploymentID string    `json:"deploymentId,omitempty"`
	Description  string    `json:"description"`
	LastError    string    `json:"lastError"`
	Attempts     int       `json:"attempts"`
	NextRetryAt  time.Time `json:"nextRetryAt"`
}

type StatusReport struct {
	Resources        *Resources              `json:"resources,omitempty"`
	PublicIP         string                  `json:"publicIp,omitempty"`
	PrivateIP        string                  `json:"privateIp,omitempty"`
	Meta             map[string]string       `json:"meta,omitempty"`
	Containers       []ContainerStatus       `json:"containers"`
	DeploymentErrors []DeploymentError       `json:"deploymentErrors,omitempty"`
	DnsInSync        bool                    `json:"dnsInSync,omitempty"`
	NetworkHealth    *health.NetworkHealth   `json:"networkHealth,omitempty"`
	ContainerHealth  *health.ContainerHealth `json:"containerHealth,omitempty"`
	AgentHealth      *AgentHealth            `json:"agentHealth,omitempty"`
}

type CompletedWorkItem struct {
	ID      string `json:"id"`
	Attempt int    `json:"attempt"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
}

type ActiveWorkItem struct {
	ID      string `json:"id"`
	Attempt int    `json:"attempt"`
}

type ServerlessTransition struct {
	ID           string `json:"id,omitempty"`
	Type         string `json:"type"`
	DeploymentID string `json:"deploymentId"`
	ContainerID  string `json:"containerId,omitempty"`
	Error        string `json:"error,omitempty"`
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
	CloneURL        string            `json:"cloneUrl"`
	ImageRepository string            `json:"imageRepository"`
	ImageURI        string            `json:"imageUri"`
	RootDir         string            `json:"rootDir"`
	Secrets         map[string]string `json:"secrets"`
	TimeoutMinutes  int               `json:"timeoutMinutes"`
	TargetPlatforms []string          `json:"targetPlatforms"`
}

func (c *Client) ClaimBuild(buildID string) (*BuildDetails, error) {
	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/agent/builds/"+buildID, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	c.signRequest(req, "")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to claim build: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("claim build failed with status %d: %s", resp.StatusCode, string(body))
	}

	var result BuildDetails
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode build: %w", err)
	}

	return &result, nil
}

func (c *Client) UpdateBuildStatus(buildID, status, errorMsg, resolvedCommitSha string) error {
	payload := map[string]string{
		"status": status,
	}
	if errorMsg != "" {
		payload["error"] = errorMsg
	}
	if resolvedCommitSha != "" {
		payload["resolvedCommitSha"] = resolvedCommitSha
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
	Attempt int    `json:"attempt"`
}

type RejectedWorkItemResult struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type StatusResponse struct {
	OK                          bool                         `json:"ok"`
	AcceptedWorkItemResults     []string                     `json:"acceptedWorkItemResults"`
	RejectedWorkItemResults     []RejectedWorkItemResult     `json:"rejectedWorkItemResults"`
	RejectedActiveWorkItems     []RejectedWorkItemResult     `json:"rejectedActiveWorkItems"`
	ServerlessTransitionResults []ServerlessTransitionResult `json:"serverlessTransitionResults"`
	WorkItems                   []WorkQueueItem              `json:"workItems"`
}

type ServerlessTransitionResult struct {
	ID           string `json:"id,omitempty"`
	Type         string `json:"type,omitempty"`
	DeploymentID string `json:"deploymentId,omitempty"`
	Outcome      string `json:"outcome"`
	Reason       string `json:"reason,omitempty"`
}

func (c *Client) ReportStatus(report *StatusReport, completed []CompletedWorkItem, active []ActiveWorkItem, serverlessTransitions []ServerlessTransition) (*StatusResponse, error) {
	payload := map[string]interface{}{
		"statusReport": report,
	}
	if len(completed) > 0 {
		payload["completedWorkItems"] = completed
	}
	if len(active) > 0 {
		payload["activeWorkItems"] = active
	}
	if len(serverlessTransitions) > 0 {
		payload["serverlessTransitions"] = serverlessTransitions
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal status report: %w", err)
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/agent/status", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, string(body))

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to report status: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("status report failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var statusResponse StatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&statusResponse); err != nil {
		return nil, fmt.Errorf("failed to decode status response: %w", err)
	}

	return &statusResponse, nil
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

func (c *Client) ReportBackupComplete(backupID string, sizeBytes int64, checksum string) error {
	payload := map[string]interface{}{
		"backupId":  backupID,
		"sizeBytes": sizeBytes,
		"checksum":  checksum,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal backup complete: %w", err)
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/agent/backup/complete", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, string(body))

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to report backup complete: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("backup complete report failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

func (c *Client) ReportBackupFailed(backupID string, errorMsg string) error {
	payload := map[string]interface{}{
		"backupId": backupID,
		"error":    errorMsg,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal backup failed: %w", err)
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/agent/backup/failed", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, string(body))

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to report backup failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("backup failed report failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

func (c *Client) ReportRestoreComplete(backupID string, success bool, errorMsg string) error {
	payload := map[string]interface{}{
		"backupId": backupID,
		"success":  success,
	}
	if errorMsg != "" {
		payload["error"] = errorMsg
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal restore complete: %w", err)
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/agent/restore/complete", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, string(body))

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to report restore complete: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("restore complete report failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}
