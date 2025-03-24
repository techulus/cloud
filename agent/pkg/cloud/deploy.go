package cloud

import (
	"bufio"
	"context"
	"fmt"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
)

// Secret is the structure of a secret
type Secret struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// ServiceAction is the structure of the service action
type ServiceAction struct {
	ServiceID    string   `json:"service_id"`
	DeploymentID string   `json:"deployment_id"`
	Operation    string   `json:"operation"`
	Image        string   `json:"image"`
	Tag          string   `json:"tag"`
	Secrets      []Secret `json:"secrets"`
}

// ExecuteAction executes an action
func ExecuteAction(action *ServiceAction) error {
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

		SendDeploymentLogs(action.DeploymentID, logs)

		defer imgResp.Close()

		environment := []string{}
		for _, secret := range action.Secrets {
			environment = append(environment, fmt.Sprintf("%s=%s", secret.Name, secret.Value))
		}

		serviceContainer, err := cli.ContainerCreate(ctx, &container.Config{
			Image: action.Image,
			Labels: map[string]string{
				"techulus.cloud.service": action.ServiceID,
				"managed.by":             "techulus.cloud",
			},
			Env: environment,
		}, nil, nil, nil, action.ServiceID)

		if err != nil {
			if strings.Contains(err.Error(), fmt.Sprintf("The container name \"/%s\" is already in use by container", action.ServiceID)) {
				fmt.Printf("Container is already created\n")
			} else {
				return fmt.Errorf("failed to create container: %v", err)
			}
		}

		fmt.Printf("Container created: %s\n", serviceContainer.ID)

		if err := cli.ContainerStart(ctx, serviceContainer.ID, container.StartOptions{}); err != nil {
			return fmt.Errorf("failed to start container: %v", err)
		}

		fmt.Printf("Container started: %s\n", serviceContainer.ID)

	case "update":
		fmt.Printf("Updating service: %s:%s\n", action.Image, action.Tag)

	case "delete":
		fmt.Printf("Deleting service: %s:%s\n", action.Image, action.Tag)

	default:
		fmt.Printf("Unsupported operation: %s\n", action.Operation)
	}

	return nil
}
