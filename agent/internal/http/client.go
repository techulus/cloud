package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"techulus/cloud-agent/internal/crypto"
	"techulus/cloud-agent/internal/health"
	"techulus/cloud-agent/internal/registryauth"
)

type Client struct {
	baseURL  string
	serverID string
	keyPair  *crypto.KeyPair
	client   *http.Client
	dataDir  string
}

func (c *Client) GetRegistryBundle(ctx context.Context) (*registryauth.Bundle, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/v1/agent/registries", nil)
	if err != nil {
		return nil, fmt.Errorf("create registry request: %w", err)
	}
	c.signRequest(req, "")
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch registry bundle: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch registry bundle returned status %d", resp.StatusCode)
	}
	limited := io.LimitReader(resp.Body, 2*1024*1024+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("read registry response: %w", err)
	}
	if len(data) > 2*1024*1024 {
		return nil, errors.New("registry response too large")
	}
	var bundle registryauth.Bundle
	if err = json.Unmarshal(data, &bundle); err != nil {
		return nil, errors.New("invalid registry response")
	}
	return &bundle, nil
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
	message := "agent-request:v2\x00" + timestamp + "\x00" + req.Method + "\x00" + req.URL.RequestURI() + "\x00" + body
	signature := c.keyPair.Sign([]byte(message))

	req.Header.Set("x-server-id", c.serverID)
	req.Header.Set("x-timestamp", timestamp)
	req.Header.Set("x-signature", signature)
}

func (c *Client) doSignedJSONRequest(url string, body []byte, acceptedStatuses []int, requestError, responseError string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.signRequest(req, string(body))
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", requestError, err)
	}
	for _, status := range acceptedStatuses {
		if resp.StatusCode == status {
			return resp, nil
		}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	return nil, fmt.Errorf("%s with status %d: %s", responseError, resp.StatusCode, string(respBody))
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
	ServerName            string              `json:"serverName"`
	RoutingSyncRolloutIds []string            `json:"routingSyncRolloutIds,omitempty"`
	Containers            []ExpectedContainer `json:"containers"`
	Dns                   struct {
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
	if err := os.MkdirAll(c.dataDir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(c.dataDir, expectedStateCacheFile+".tmp-")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func (c *Client) LoadCachedExpectedState() (*ExpectedState, error) {
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
	cachedState, cacheErr := c.LoadCachedExpectedState()
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
	Version      string   `json:"version"`
	UptimeSecs   int64    `json:"uptimeSecs"`
	Capabilities []string `json:"capabilities,omitempty"`
}

type StatusReport struct {
	Resources               *Resources              `json:"resources,omitempty"`
	PublicIP                string                  `json:"publicIp,omitempty"`
	PrivateIP               string                  `json:"privateIp,omitempty"`
	Meta                    map[string]string       `json:"meta,omitempty"`
	Containers              []ContainerStatus       `json:"containers"`
	DeploymentErrors        []DeploymentError       `json:"deploymentErrors,omitempty"`
	RoutingSyncedRolloutIds []string                `json:"routingSyncedRolloutIds,omitempty"`
	NetworkHealth           *health.NetworkHealth   `json:"networkHealth,omitempty"`
	ContainerHealth         *health.ContainerHealth `json:"containerHealth,omitempty"`
	CrowdSecHealth          *health.CrowdSecHealth  `json:"crowdsecHealth,omitempty"`
	AgentHealth             *AgentHealth            `json:"agentHealth,omitempty"`
}

type CompletedWorkItem struct {
	ID      string         `json:"id"`
	Attempt int            `json:"attempt"`
	Status  string         `json:"status"`
	Error   string         `json:"error,omitempty"`
	Result  WorkItemResult `json:"result,omitempty"`
}

type WorkItemResult interface {
	isWorkItemResult()
}

type CommandWorkItemResult struct {
	Type            string `json:"type"`
	Output          string `json:"output,omitempty"`
	ExitCode        *int   `json:"exitCode,omitempty"`
	OutputTruncated bool   `json:"outputTruncated,omitempty"`
	TimedOut        bool   `json:"timedOut,omitempty"`
}

func (CommandWorkItemResult) isWorkItemResult() {}

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
		GitRef        string `json:"gitRef"`
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

func (c *Client) UpdateBuildStatus(buildID, status, errorMsg, resolvedCommitSha, imageURI string) error {
	payload := map[string]string{
		"status": status,
	}
	if errorMsg != "" {
		payload["error"] = errorMsg
	}
	if resolvedCommitSha != "" {
		payload["resolvedCommitSha"] = resolvedCommitSha
	}
	if imageURI != "" {
		payload["imageUri"] = imageURI
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal status update: %w", err)
	}

	resp, err := c.doSignedJSONRequest(c.baseURL+"/api/v1/agent/builds/"+buildID+"/status", body, []int{http.StatusOK}, "failed to update build status", "build status update failed")
	if err != nil {
		return err
	}
	defer resp.Body.Close()

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

var ErrWorkWaitUnsupported = errors.New("work wait endpoint unsupported")

type WorkWaitResponse struct {
	WorkAvailable bool `json:"workAvailable"`
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

	resp, err := c.doSignedJSONRequest(c.baseURL+"/api/v1/agent/status", body, []int{http.StatusOK, http.StatusAccepted}, "failed to report status", "status report failed")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var statusResponse StatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&statusResponse); err != nil {
		return nil, fmt.Errorf("failed to decode status response: %w", err)
	}

	return &statusResponse, nil
}

func (c *Client) WaitForWork(ctx context.Context) (bool, error) {
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		c.baseURL+"/api/v1/agent/work/wait",
		nil,
	)
	if err != nil {
		return false, fmt.Errorf("failed to create work wait request: %w", err)
	}
	c.signRequest(req, "")

	resp, err := c.client.Do(req)
	if err != nil {
		return false, fmt.Errorf("failed to wait for work: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusMethodNotAllowed {
		return false, ErrWorkWaitUnsupported
	}
	if resp.StatusCode == http.StatusNotFound {
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		if readErr != nil {
			return false, fmt.Errorf("failed to read work wait response: %w", readErr)
		}
		var errorResponse struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(body, &errorResponse) != nil || errorResponse.Error == "" {
			return false, ErrWorkWaitUnsupported
		}
		return false, fmt.Errorf("work wait failed with status %d: %s", resp.StatusCode, string(body))
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		return false, fmt.Errorf("work wait failed with status %d: %s", resp.StatusCode, string(body))
	}

	var workWaitResponse WorkWaitResponse
	if err := json.NewDecoder(resp.Body).Decode(&workWaitResponse); err != nil {
		return false, fmt.Errorf("failed to decode work wait response: %w", err)
	}
	return workWaitResponse.WorkAvailable, nil
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

	resp, err := c.doSignedJSONRequest(c.baseURL+"/api/v1/agent/backup/complete", body, []int{http.StatusOK}, "failed to report backup complete", "backup complete report failed")
	if err != nil {
		return err
	}
	defer resp.Body.Close()

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

	resp, err := c.doSignedJSONRequest(c.baseURL+"/api/v1/agent/backup/failed", body, []int{http.StatusOK}, "failed to report backup failed", "backup failed report failed")
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	return nil
}
