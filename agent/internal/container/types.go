package container

import "time"

const NetworkName = "techulus"

type PortMapping struct {
	ContainerPort int
	HostPort      int
}

type HealthCheck struct {
	Cmd         string
	Interval    int
	Timeout     int
	Retries     int
	StartPeriod int
}

type VolumeMount struct {
	Name          string
	HostPath      string
	ContainerPath string
}

type BuildLogFunc func(stream string, message string)

type DeployConfig struct {
	Name          string
	Image         string
	ServiceID     string
	ServiceName   string
	DeploymentID  string
	WireGuardIP   string
	IPAddress     string
	PortMappings  []PortMapping
	HealthCheck   *HealthCheck
	Env           map[string]string
	VolumeMounts  []VolumeMount
	StartCommand  string
	CPULimit      *float64
	MemoryLimitMb *int
	LogFunc       BuildLogFunc
}

type DeployResult struct {
	ContainerID string
}

type Container struct {
	ID           string            `json:"Id"`
	Name         string            `json:"Name"`
	Image        string            `json:"Image"`
	State        string            `json:"State"`
	Created      int64             `json:"Created"`
	Labels       map[string]string `json:"Labels"`
	DeploymentID string
	ServiceID    string
}

type containerInspect struct {
	State struct {
		Status  string `json:"Status"`
		Running bool   `json:"Running"`
	} `json:"State"`
}

type LogEntry struct {
	Stream    string
	Timestamp time.Time
	Message   []byte
}

type LogsOptions struct {
	ContainerID string
	Follow      bool
	Tail        int
	Since       string
	Until       string
}
