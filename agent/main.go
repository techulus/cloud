package main

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"golang.org/x/net/context"
)

type ServerResponse struct {
	Ok      bool            `json:"ok"`
	Actions []ServiceAction `json:"actions"`
	Error   *string         `json:"error"`
}

type ServiceAction struct {
	ServiceID    string   `json:"service_id"`
	DeploymentID string   `json:"deployment_id"`
	Operation    string   `json:"operation"`
	Image        string   `json:"image"`
	Tag          string   `json:"tag"`
	Secrets      []Secret `json:"secrets"`
}

type Secret struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type StatusUpdate struct {
	Containers []container.Summary `json:"containers"`
	Images     []image.Summary     `json:"images"`
	Networks   []network.Inspect   `json:"networks"`
}

type LogsUpdate struct {
	DeploymentID string   `json:"deployment_id"`
	Logs         []string `json:"logs"`
}

func computeSignature(key []byte, message []byte) string {
	mac := hmac.New(sha256.New, key)
	mac.Write(message)
	signature := mac.Sum(nil)
	return base64.StdEncoding.EncodeToString(signature)
}

func sendStatusUpdate() error {
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
	url := "http://localhost:3000/api/v1/agent/status"

	statusUpdate := StatusUpdate{
		Containers: containers,
		Images:     images,
		Networks:   networks,
	}

	body, err := json.Marshal(statusUpdate)
	if err != nil {
		return fmt.Errorf("failed to marshal status update: %v", err)
	}

	signature := computeSignature(
		[]byte("4abd321e-2834-4d9d-b8cd-d8e07dc0043f"),
		body,
	)

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %v", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-agent-token", "e042ca15-f270-47f0-8b03-9d7a2e77e363")
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
			if err := executeAction(&action); err != nil {
				fmt.Printf("Failed to execute action: %v\n", err)
			}
		}
	}

	return nil
}

func sendLogs(deploymentID string, logs []string) error {
	client := &http.Client{}
	url := "http://localhost:3000/api/v1/agent/deployment/logs"

	logsUpdate := LogsUpdate{
		DeploymentID: deploymentID,
		Logs:         logs,
	}

	body, err := json.Marshal(logsUpdate)
	if err != nil {
		return fmt.Errorf("failed to marshal logs update: %v", err)
	}

	signature := computeSignature(
		[]byte("4abd321e-2834-4d9d-b8cd-d8e07dc0043f"),
		body,
	)

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %v", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-agent-token", "e042ca15-f270-47f0-8b03-9d7a2e77e363")
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

func executeAction(action *ServiceAction) error {
	cli, err := client.NewClientWithOpts(client.WithHost("unix:///Users/arjunkomath/.docker/run/docker.sock"))
	if err != nil {
		return fmt.Errorf("failed to create docker client: %v", err)
	}
	defer cli.Close()

	switch action.Operation {
	case "create":
		fmt.Printf("Starting service: %s:%s\n", action.Image, action.Tag)

		ctx := context.Background()

		imgResp, err := cli.ImagePull(ctx, action.Image, image.PullOptions{
			All: true,
		})
		if err != nil {
			return fmt.Errorf("failed to pull image: %v", err)
		}

		var logs []string
		scanner := bufio.NewScanner(imgResp)
		for scanner.Scan() {
			logs = append(logs, scanner.Text())
		}
		if err := scanner.Err(); err != nil {
			return fmt.Errorf("error reading image pull logs: %v", err)
		}

		sendLogs(action.DeploymentID, logs)

		defer imgResp.Close()

		environment := []string{}
		for _, secret := range action.Secrets {
			environment = append(environment, fmt.Sprintf("%s=%s", secret.Name, secret.Value))
		}

		resp, err := cli.ContainerCreate(ctx, &container.Config{
			Image: action.Image,
			Labels: map[string]string{
				"techulus.cloud.service": action.ServiceID,
				"managed.by":             "techulus.cloud",
			},
			Env: environment,
		}, nil, nil, nil, action.ServiceID)
		if err != nil {
			return fmt.Errorf("failed to create container: %v", err)
		}

		fmt.Printf("Container created: %s\n", resp.ID)

		if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
			return fmt.Errorf("failed to start container: %v", err)
		}

		fmt.Printf("Container started: %s\n", resp.ID)

	case "update":
		fmt.Printf("Updating service: %s:%s\n", action.Image, action.Tag)

	case "delete":
		fmt.Printf("Deleting service: %s:%s\n", action.Image, action.Tag)

	default:
		fmt.Printf("Unsupported operation: %s\n", action.Operation)
	}

	return nil
}

func main() {
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt)

	ticker := time.NewTicker(300 * time.Second)
	defer ticker.Stop()

	if err := sendStatusUpdate(); err != nil {
		fmt.Printf("Failed to send status update: %v\n", err)
	}

	for {
		select {
		case <-shutdown:
			fmt.Println("Shutting down agent...")
			return
		case <-ticker.C:
			if err := sendStatusUpdate(); err != nil {
				fmt.Printf("Failed to send status update: %v\n", err)
			}
		}
	}
}
