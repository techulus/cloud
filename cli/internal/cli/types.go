package cli

import (
	"fmt"

	"techulus/cloud-cli/internal/auth"
	"techulus/cloud-cli/internal/manifest"
)

type deviceCodeResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type deviceTokenResponse struct {
	AccessToken      string `json:"access_token"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

type exchangeResponse struct {
	APIKey string    `json:"apiKey"`
	KeyID  string    `json:"keyId"`
	Name   string    `json:"name"`
	User   auth.User `json:"user"`
}

type authWhoamiOutput struct {
	User auth.User `json:"user"`
	Host string    `json:"host"`
}

type initOutput struct {
	Manifest string `json:"manifest"`
	Next     string `json:"next"`
}

type linkServiceTarget struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Project           string `json:"project"`
	Environment       string `json:"environment"`
	LinkSupported     bool   `json:"linkSupported"`
	UnsupportedReason string `json:"unsupportedReason"`
}

type linkEnvironmentTarget struct {
	ID       string              `json:"id"`
	Name     string              `json:"name"`
	Services []linkServiceTarget `json:"services"`
}

type linkProjectTarget struct {
	ID           string                  `json:"id"`
	Name         string                  `json:"name"`
	Slug         string                  `json:"slug"`
	Environments []linkEnvironmentTarget `json:"environments"`
}

type linkTargetsResponse struct {
	Projects []linkProjectTarget `json:"projects"`
}

type linkManifestResponse struct {
	Manifest manifest.Manifest `json:"manifest"`
	Service  struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Project     string `json:"project"`
		Environment string `json:"environment"`
	} `json:"service"`
}

type manifestChange struct {
	Field string `json:"field"`
	From  string `json:"from"`
	To    string `json:"to"`
}

type applyResponse struct {
	Action    string           `json:"action"`
	ServiceID string           `json:"serviceId"`
	Changes   []manifestChange `json:"changes"`
}

type deployResponse struct {
	ServiceID string  `json:"serviceId"`
	RolloutID *string `json:"rolloutId"`
	Status    string  `json:"status"`
}

type statusResponse struct {
	Service struct {
		ID       string  `json:"id"`
		Name     string  `json:"name"`
		Image    string  `json:"image"`
		Hostname *string `json:"hostname"`
		Replicas int     `json:"replicas"`
	} `json:"service"`
	LatestRollout *struct {
		ID           string  `json:"id"`
		Status       string  `json:"status"`
		CurrentStage *string `json:"currentStage"`
	} `json:"latestRollout"`
	Deployments []struct {
		ID       string `json:"id"`
		Status   string `json:"status"`
		ServerID string `json:"serverId"`
	} `json:"deployments"`
}

type serviceLog struct {
	DeploymentID string `json:"deploymentId"`
	Stream       string `json:"stream"`
	Message      string `json:"message"`
	Timestamp    string `json:"timestamp"`
}

type logsResponse struct {
	LoggingEnabled bool         `json:"loggingEnabled"`
	Logs           []serviceLog `json:"logs"`
}

type serviceTargetOutput struct {
	Project     string `json:"project"`
	Environment string `json:"environment"`
	Service     string `json:"service"`
}

type statusOutput struct {
	Target serviceTargetOutput `json:"target"`
	Status statusResponse      `json:"status"`
}

type logsOutput struct {
	Target         serviceTargetOutput `json:"target"`
	LoggingEnabled bool                `json:"loggingEnabled"`
	Logs           []serviceLog        `json:"logs"`
}

func countSupportedServices(projects []linkProjectTarget) int {
	total := 0
	for _, project := range projects {
		for _, environment := range project.Environments {
			for _, service := range environment.Services {
				if service.LinkSupported {
					total++
				}
			}
		}
	}
	return total
}

func filterProjectsWithServices(projects []linkProjectTarget) []linkProjectTarget {
	var filtered []linkProjectTarget
	for _, project := range projects {
		for _, environment := range project.Environments {
			if len(environment.Services) > 0 {
				filtered = append(filtered, project)
				break
			}
		}
	}
	return filtered
}

func filterEnvironmentsWithServices(environments []linkEnvironmentTarget) []linkEnvironmentTarget {
	var filtered []linkEnvironmentTarget
	for _, environment := range environments {
		if len(environment.Services) > 0 {
			filtered = append(filtered, environment)
		}
	}
	return filtered
}

func renderProjectChoice(project linkProjectTarget) string {
	serviceCount := 0
	for _, environment := range project.Environments {
		serviceCount += len(environment.Services)
	}
	suffix := "s"
	if serviceCount == 1 {
		suffix = ""
	}
	return fmt.Sprintf("%s (%d service%s)", project.Name, serviceCount, suffix)
}

func renderEnvironmentChoice(environment linkEnvironmentTarget) string {
	supportedCount := 0
	for _, service := range environment.Services {
		if service.LinkSupported {
			supportedCount++
		}
	}
	return fmt.Sprintf("%s (%d/%d linkable)", environment.Name, supportedCount, len(environment.Services))
}

func renderServiceChoice(service linkServiceTarget) string {
	if service.LinkSupported {
		return service.Name
	}
	reason := service.UnsupportedReason
	if reason == "" {
		reason = "unsupported"
	}
	return fmt.Sprintf("%s (unsupported: %s)", service.Name, reason)
}

func disabledServiceReason(service linkServiceTarget) string {
	if service.LinkSupported {
		return ""
	}
	if service.UnsupportedReason != "" {
		return service.UnsupportedReason
	}
	return "This service cannot be linked."
}
