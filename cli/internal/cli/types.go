package cli

import (
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
	APIKey string `json:"apiKey"`
	KeyID  string `json:"keyId"`
	Name   string `json:"name"`
}
type authWhoamiOutput struct {
	User auth.User `json:"user"`
	Host string    `json:"host"`
}
type initOutput struct {
	Manifest string `json:"manifest"`
	Next     string `json:"next"`
}
type projectItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}
type environmentItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type serviceItem struct {
	ID           string                `json:"id"`
	Name         string                `json:"name"`
	Hostname     *string               `json:"hostname"`
	Source       manifest.Source       `json:"source"`
	Ports        []manifest.Port       `json:"ports"`
	Replicas     int                   `json:"replicas"`
	Placement    *manifest.Placement   `json:"placement"`
	HealthCheck  *manifest.HealthCheck `json:"healthCheck"`
	StartCommand *string               `json:"startCommand"`
	Resources    *manifest.Resources   `json:"resources"`
}
type targetProject struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
}
type targetEnvironment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type targetService struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type targetContext struct {
	Project     targetProject     `json:"project"`
	Environment targetEnvironment `json:"environment"`
	Service     targetService     `json:"service"`
}
type managementBlocker struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type serviceManagement struct {
	Patchable bool                `json:"patchable"`
	Blockers  []managementBlocker `json:"blockers"`
}
type projectsResponse struct {
	Projects   []projectItem `json:"projects"`
	NextCursor string        `json:"nextCursor,omitempty"`
}
type environmentsResponse struct {
	Environments []environmentItem `json:"environments"`
	NextCursor   string            `json:"nextCursor,omitempty"`
}
type servicesResponse struct {
	Services   []serviceItem `json:"services"`
	NextCursor string        `json:"nextCursor,omitempty"`
}
type applyResponse struct {
	Action  string   `json:"action"`
	Changes []string `json:"changes"`
}
type deployResponse struct {
	Operation string  `json:"operation"`
	Status    string  `json:"status"`
	RolloutID *string `json:"rolloutId"`
	BuildID   *string `json:"buildId"`
}
type statusResponse struct {
	Target  targetContext `json:"target"`
	Service struct {
		ID     string          `json:"id"`
		Name   string          `json:"name"`
		Source manifest.Source `json:"source"`
	} `json:"service"`
	LatestBuild   map[string]any   `json:"latestBuild"`
	LatestRollout map[string]any   `json:"latestRollout"`
	Deployments   []map[string]any `json:"deployments"`
}
type serviceLog struct {
	DeploymentID *string `json:"deploymentId"`
	Stream       string  `json:"stream"`
	Message      string  `json:"message"`
	Timestamp    string  `json:"timestamp"`
}

type logsResponse struct {
	Target      targetContext `json:"target"`
	Provider    string        `json:"provider"`
	Logs        []serviceLog  `json:"logs"`
	NextCursor  string        `json:"nextCursor"`
	HasMore     bool          `json:"hasMore"`
	PollAfterMS int           `json:"pollAfterMs"`
}
