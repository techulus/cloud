package manifest

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

type Manifest struct {
	APIVersion  string  `json:"apiVersion" yaml:"apiVersion"`
	Project     string  `json:"project" yaml:"project"`
	Environment string  `json:"environment" yaml:"environment"`
	Service     Service `json:"service" yaml:"service"`
}

type Service struct {
	Name         string       `json:"name" yaml:"name"`
	Source       Source       `json:"source" yaml:"source"`
	Hostname     *string      `json:"hostname,omitempty" yaml:"hostname,omitempty"`
	Ports        []Port       `json:"ports,omitempty" yaml:"ports,omitempty"`
	Replicas     Replicas     `json:"replicas" yaml:"replicas"`
	HealthCheck  *HealthCheck `json:"healthCheck,omitempty" yaml:"healthCheck,omitempty"`
	StartCommand *string      `json:"startCommand,omitempty" yaml:"startCommand,omitempty"`
	Resources    *Resources   `json:"resources,omitempty" yaml:"resources,omitempty"`
}

type Source struct {
	Type  string `json:"type" yaml:"type"`
	Image string `json:"image" yaml:"image"`
}

type Port struct {
	Port   int    `json:"port" yaml:"port"`
	Public bool   `json:"public" yaml:"public"`
	Domain string `json:"domain,omitempty" yaml:"domain,omitempty"`
}

type Replicas struct {
	Count int `json:"count" yaml:"count"`
}

type HealthCheck struct {
	Cmd         string `json:"cmd" yaml:"cmd"`
	Interval    int    `json:"interval" yaml:"interval"`
	Timeout     int    `json:"timeout" yaml:"timeout"`
	Retries     int    `json:"retries" yaml:"retries"`
	StartPeriod int    `json:"startPeriod" yaml:"startPeriod"`
}

type Resources struct {
	CPUCores *float64 `json:"cpuCores,omitempty" yaml:"cpuCores,omitempty"`
	MemoryMB *int     `json:"memoryMb,omitempty" yaml:"memoryMb,omitempty"`
}

type Loaded struct {
	Path     string
	Manifest Manifest
}

func Load(cwd string) (*Loaded, error) {
	path := filepath.Join(cwd, "techulus.yml")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	parsed, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	return &Loaded{Path: path, Manifest: parsed}, nil
}

func Parse(raw []byte) (Manifest, error) {
	var parsed Manifest
	decoder := yaml.NewDecoder(bytes.NewReader(raw))
	decoder.KnownFields(true)
	if err := decoder.Decode(&parsed); err != nil {
		return Manifest{}, err
	}
	ApplyDefaults(&parsed)
	return parsed, Validate(parsed)
}

func Marshal(value Manifest) ([]byte, error) {
	ApplyDefaults(&value)
	if err := Validate(value); err != nil {
		return nil, err
	}
	return yaml.Marshal(value)
}

func Save(path string, value Manifest) error {
	raw, err := Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o644)
}

func ApplyDefaults(value *Manifest) {
	value.Project = strings.TrimSpace(value.Project)
	value.Environment = strings.TrimSpace(value.Environment)
	value.Service.Name = strings.TrimSpace(value.Service.Name)
	value.Service.Source.Type = strings.TrimSpace(value.Service.Source.Type)
	value.Service.Source.Image = strings.TrimSpace(value.Service.Source.Image)
	if value.Service.Hostname != nil {
		trimmed := strings.TrimSpace(*value.Service.Hostname)
		value.Service.Hostname = &trimmed
	}
	if value.Service.StartCommand != nil {
		trimmed := strings.TrimSpace(*value.Service.StartCommand)
		value.Service.StartCommand = &trimmed
	}
	if value.Service.Ports == nil {
		value.Service.Ports = []Port{}
	}
	for index := range value.Service.Ports {
		value.Service.Ports[index].Domain = strings.TrimSpace(value.Service.Ports[index].Domain)
	}
	if value.Service.Replicas.Count == 0 {
		value.Service.Replicas.Count = 1
	}
	if value.Service.HealthCheck != nil {
		value.Service.HealthCheck.Cmd = strings.TrimSpace(value.Service.HealthCheck.Cmd)
		if value.Service.HealthCheck.Interval == 0 {
			value.Service.HealthCheck.Interval = 10
		}
		if value.Service.HealthCheck.Timeout == 0 {
			value.Service.HealthCheck.Timeout = 5
		}
		if value.Service.HealthCheck.Retries == 0 {
			value.Service.HealthCheck.Retries = 3
		}
		if value.Service.HealthCheck.StartPeriod == 0 {
			value.Service.HealthCheck.StartPeriod = 30
		}
	}
}

func Validate(value Manifest) error {
	if value.APIVersion != "v1" {
		return errors.New("apiVersion must be v1")
	}
	if strings.TrimSpace(value.Project) == "" {
		return errors.New("project is required")
	}
	if strings.TrimSpace(value.Environment) == "" {
		return errors.New("environment is required")
	}
	if strings.TrimSpace(value.Service.Name) == "" {
		return errors.New("service.name is required")
	}
	if value.Service.Source.Type != "image" {
		return errors.New("service.source.type must be image")
	}
	if strings.TrimSpace(value.Service.Source.Image) == "" {
		return errors.New("service.source.image is required")
	}
	if value.Service.Hostname != nil && *value.Service.Hostname == "" {
		return errors.New("service.hostname cannot be blank")
	}
	if value.Service.Replicas.Count < 1 || value.Service.Replicas.Count > 10 {
		return errors.New("service.replicas.count must be between 1 and 10")
	}
	for index, port := range value.Service.Ports {
		if port.Port < 1 || port.Port > 65535 {
			return fmt.Errorf("service.ports[%d].port must be between 1 and 65535", index)
		}
		if port.Public && strings.TrimSpace(port.Domain) == "" {
			return fmt.Errorf("service.ports[%d].domain is required for public ports", index)
		}
		if !port.Public && strings.TrimSpace(port.Domain) != "" {
			return fmt.Errorf("service.ports[%d].domain cannot be set for internal ports", index)
		}
	}
	if health := value.Service.HealthCheck; health != nil {
		if strings.TrimSpace(health.Cmd) == "" {
			return errors.New("service.healthCheck.cmd is required")
		}
		if health.Interval < 1 {
			return errors.New("service.healthCheck.interval must be at least 1")
		}
		if health.Timeout < 1 {
			return errors.New("service.healthCheck.timeout must be at least 1")
		}
		if health.Retries < 1 {
			return errors.New("service.healthCheck.retries must be at least 1")
		}
		if health.StartPeriod < 0 {
			return errors.New("service.healthCheck.startPeriod must be at least 0")
		}
	}
	if value.Service.StartCommand != nil && *value.Service.StartCommand == "" {
		return errors.New("service.startCommand cannot be blank")
	}
	if resources := value.Service.Resources; resources != nil {
		hasCPU := resources.CPUCores != nil
		hasMemory := resources.MemoryMB != nil
		if hasCPU != hasMemory {
			return errors.New("service.resources must set both cpuCores and memoryMb together")
		}
		if resources.CPUCores != nil && (*resources.CPUCores < 0.1 || *resources.CPUCores > 64) {
			return errors.New("service.resources.cpuCores must be between 0.1 and 64")
		}
		if resources.MemoryMB != nil && (*resources.MemoryMB < 64 || *resources.MemoryMB > 65536) {
			return errors.New("service.resources.memoryMb must be between 64 and 65536")
		}
	}
	return nil
}

var slugChars = regexp.MustCompile(`[^a-z0-9]+`)

func Slugify(value string) string {
	slug := strings.ToLower(value)
	slug = slugChars.ReplaceAllString(slug, "-")
	return strings.Trim(slug, "-")
}
