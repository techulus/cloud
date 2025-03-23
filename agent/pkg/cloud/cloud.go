package cloud

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
)

const (
	serverBaseURL = "http://localhost:3000/api/v1"
	agentToken    = "e042ca15-f270-47f0-8b03-9d7a2e77e363"
	agentSecret   = "4abd321e-2834-4d9d-b8cd-d8e07dc0043f"
)

// ComputeSignature computes a signature for a message using a secret key
func ComputeSignature(key []byte, message []byte) string {
	mac := hmac.New(sha256.New, key)
	mac.Write(message)
	signature := mac.Sum(nil)
	return base64.StdEncoding.EncodeToString(signature)
}

type ServerResponse struct {
	Ok      bool            `json:"ok"`
	Actions []ServiceAction `json:"actions"`
	Error   *string         `json:"error"`
}

type StatusUpdate struct {
	Containers []container.Summary `json:"containers"`
	Images     []image.Summary     `json:"images"`
	Networks   []network.Inspect   `json:"networks"`
}

// SendStatusUpdate sends a status update to the server
func SendStatusUpdate() error {
	ctx := context.Background()
	cli, err := client.NewClientWithOpts(client.WithHost("unix:///Users/arjunkomath/.docker/run/docker.sock"))
	if err != nil {
		fmt.Printf("Failed to create docker client: %v\n", err)
		os.Exit(1)
	}
	defer cli.Close()

	containers, err := cli.ContainerList(ctx, container.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", "techulus.cloud.service"))})
	if err != nil {
		fmt.Printf("Failed to list containers: %v\n", err)
		return err
	}

	images, err := cli.ImageList(ctx, image.ListOptions{All: true, Filters: filters.NewArgs(filters.Arg("label", "techulus.cloud.service"))})
	if err != nil {
		fmt.Printf("Failed to list images: %v\n", err)
		return err
	}

	networks, err := cli.NetworkList(ctx, network.ListOptions{Filters: filters.NewArgs(filters.Arg("label", "techulus.cloud.service"))})
	if err != nil {
		fmt.Printf("Failed to list networks: %v\n", err)
		return err
	}

	client := &http.Client{}
	url := fmt.Sprintf("%s/agent/status", serverBaseURL)

	statusUpdate := StatusUpdate{
		Containers: containers,
		Images:     images,
		Networks:   networks,
	}

	body, err := json.Marshal(statusUpdate)
	if err != nil {
		return fmt.Errorf("failed to marshal status update: %v", err)
	}

	signature := ComputeSignature(
		[]byte(agentSecret),
		body,
	)

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %v", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-agent-token", agentToken)
	req.Header.Set("x-message-signature", signature)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %v", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response body: %v", err)
	}

	var serverResp ServerResponse
	if err := json.Unmarshal(respBody, &serverResp); err != nil {
		return fmt.Errorf("failed to parse response as JSON: %v", err)
	}

	if serverResp.Error != nil {
		fmt.Printf("Error from server: %s\n", *serverResp.Error)
	} else {
		fmt.Printf("Response - ok: %v, actions: %+v\n", serverResp.Ok, serverResp.Actions)
		for _, action := range serverResp.Actions {
			if err := ExecuteAction(&action); err != nil {
				fmt.Printf("Failed to execute action: %v\n", err)
			}
		}
	}

	return nil
}

// DeploymentLogsUpdate is the structure of the logs update request
type DeploymentLogsUpdate struct {
	DeploymentID string   `json:"deployment_id"`
	Logs         []string `json:"logs"`
}

// SendDeploymentLogs sends a deployment logs update
func SendDeploymentLogs(deploymentID string, logs []string) error {
	client := &http.Client{}
	url := fmt.Sprintf("%s/agent/deployment/logs", serverBaseURL)

	logsUpdate := DeploymentLogsUpdate{
		DeploymentID: deploymentID,
		Logs:         logs,
	}

	body, err := json.Marshal(logsUpdate)
	if err != nil {
		return fmt.Errorf("failed to marshal logs update: %v", err)
	}

	signature := ComputeSignature(
		[]byte(agentSecret),
		body,
	)

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %v", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-agent-token", agentToken)
	req.Header.Set("x-message-signature", signature)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %v", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response body: %v", err)
	}

	fmt.Printf("Response from server: %s\n", string(respBody))

	return nil
}
