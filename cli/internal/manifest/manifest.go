package manifest

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

var windowsAbsolutePath = regexp.MustCompile(`^[A-Za-z]:[\\/]`)

type Manifest struct {
	APIVersion  string      `json:"apiVersion" yaml:"apiVersion"`
	Project     Project     `json:"project" yaml:"project"`
	Environment Environment `json:"environment" yaml:"environment"`
	Service     Service     `json:"service" yaml:"service"`
}
type Project struct {
	ID   string `json:"id,omitempty" yaml:"id,omitempty"`
	Slug string `json:"slug" yaml:"slug"`
}
type Environment struct {
	ID   string `json:"id,omitempty" yaml:"id,omitempty"`
	Name string `json:"name" yaml:"name"`
}
type Service struct {
	ID           string       `json:"id,omitempty" yaml:"id,omitempty"`
	Name         string       `json:"name" yaml:"name"`
	Source       Source       `json:"source" yaml:"source"`
	Hostname     *string      `json:"hostname" yaml:"hostname"`
	Ports        []Port       `json:"ports" yaml:"ports"`
	Replicas     int          `json:"replicas" yaml:"replicas"`
	Placement    *Placement   `json:"placement,omitempty" yaml:"placement,omitempty"`
	HealthCheck  *HealthCheck `json:"healthCheck" yaml:"healthCheck"`
	StartCommand *string      `json:"startCommand" yaml:"startCommand"`
	Resources    *Resources   `json:"resources,omitempty" yaml:"resources,omitempty"`
}
type Placement struct {
	Mode    string            `json:"mode" yaml:"mode"`
	Servers []PlacementServer `json:"servers,omitempty" yaml:"servers,omitempty"`
}
type PlacementServer struct {
	ServerID string `json:"serverId" yaml:"serverId"`
	Count    int    `json:"count" yaml:"count"`
}
type Source struct {
	Type       string  `json:"type" yaml:"type"`
	Image      string  `json:"image,omitempty" yaml:"image,omitempty"`
	Repository string  `json:"repository,omitempty" yaml:"repository,omitempty"`
	Branch     string  `json:"branch,omitempty" yaml:"branch,omitempty"`
	RootDir    *string `json:"rootDir,omitempty" yaml:"rootDir,omitempty"`
}
type Port struct {
	ContainerPort int     `json:"containerPort" yaml:"containerPort"`
	Public        bool    `json:"public" yaml:"public"`
	Domain        *string `json:"domain,omitempty" yaml:"domain,omitempty"`
}
type HealthCheck struct {
	Cmd         string `json:"cmd" yaml:"cmd"`
	Interval    int    `json:"interval" yaml:"interval"`
	Timeout     int    `json:"timeout" yaml:"timeout"`
	Retries     int    `json:"retries" yaml:"retries"`
	StartPeriod int    `json:"startPeriod" yaml:"startPeriod"`
}
type Resources struct {
	CPUCores *float64 `json:"cpuCores" yaml:"cpuCores"`
	MemoryMB *int     `json:"memoryMb" yaml:"memoryMb"`
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
	m, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	return &Loaded{path, m}, nil
}
func Parse(raw []byte) (Manifest, error) {
	var m Manifest
	d := yaml.NewDecoder(bytes.NewReader(raw))
	d.KnownFields(true)
	if err := d.Decode(&m); err != nil {
		return m, err
	}
	ApplyDefaults(&m)
	return m, Validate(m)
}
func Marshal(m Manifest) ([]byte, error) {
	ApplyDefaults(&m)
	if err := Validate(m); err != nil {
		return nil, err
	}
	return yaml.Marshal(m)
}
func Save(path string, m Manifest) error {
	raw, err := Marshal(m)
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0644)
}
func ApplyDefaults(m *Manifest) {
	m.APIVersion = strings.TrimSpace(m.APIVersion)
	m.Project.ID = strings.TrimSpace(m.Project.ID)
	m.Project.Slug = strings.TrimSpace(m.Project.Slug)
	m.Environment.ID = strings.TrimSpace(m.Environment.ID)
	m.Environment.Name = strings.TrimSpace(m.Environment.Name)
	m.Service.ID = strings.TrimSpace(m.Service.ID)
	m.Service.Name = strings.TrimSpace(m.Service.Name)
	s := &m.Service.Source
	s.Type = strings.ToLower(strings.TrimSpace(s.Type))
	s.Image = strings.TrimSpace(s.Image)
	s.Repository = strings.TrimSpace(s.Repository)
	s.Branch = strings.TrimSpace(s.Branch)
	if s.Type == "github" && s.Repository != "" {
		if v, err := CanonicalGitHubRepository(s.Repository); err == nil {
			s.Repository = v
		}
	}
	if s.RootDir != nil {
		v := strings.ReplaceAll(strings.TrimSpace(*s.RootDir), "\\", "/")
		s.RootDir = &v
	}
	if m.Service.Hostname != nil {
		v := strings.TrimSpace(*m.Service.Hostname)
		m.Service.Hostname = &v
	}
	if m.Service.StartCommand != nil {
		v := strings.TrimSpace(*m.Service.StartCommand)
		m.Service.StartCommand = &v
	}
	if m.Service.Ports == nil {
		m.Service.Ports = []Port{}
	}
	if m.Service.Replicas == 0 {
		m.Service.Replicas = 1
	}
	if p := m.Service.Placement; p != nil {
		p.Mode = strings.ToLower(strings.TrimSpace(p.Mode))
		for i := range p.Servers {
			p.Servers[i].ServerID = strings.TrimSpace(p.Servers[i].ServerID)
		}
	}
	if h := m.Service.HealthCheck; h != nil {
		h.Cmd = strings.TrimSpace(h.Cmd)
		if h.Interval == 0 {
			h.Interval = 10
		}
		if h.Timeout == 0 {
			h.Timeout = 5
		}
		if h.Retries == 0 {
			h.Retries = 3
		}
		if h.StartPeriod == 0 {
			h.StartPeriod = 30
		}
	}
}
func Validate(m Manifest) error {
	if m.APIVersion != "v1" {
		return errors.New("apiVersion must be v1")
	}
	if m.Project.Slug == "" {
		return errors.New("project.slug is required")
	}
	if m.Environment.Name == "" {
		return errors.New("environment.name is required")
	}
	if m.Service.Name == "" {
		return errors.New("service.name is required")
	}
	s := m.Service.Source
	switch s.Type {
	case "image":
		if s.Image == "" {
			return errors.New("service.source.image is required")
		}
		if s.Repository != "" || s.Branch != "" || s.RootDir != nil {
			return errors.New("image source cannot contain GitHub fields")
		}
	case "github":
		if s.Image != "" {
			return errors.New("github source cannot contain image")
		}
		if _, err := CanonicalGitHubRepository(s.Repository); err != nil {
			return fmt.Errorf("service.source.repository: %w", err)
		}
		if s.Branch == "" {
			return errors.New("service.source.branch is required")
		}
		if s.RootDir != nil {
			if *s.RootDir == "" {
				return errors.New("service.source.rootDir cannot be blank")
			}
			if filepath.IsAbs(*s.RootDir) || strings.HasPrefix(*s.RootDir, "\\") || windowsAbsolutePath.MatchString(*s.RootDir) {
				return errors.New("service.source.rootDir must be relative")
			}
			for _, p := range strings.FieldsFunc(*s.RootDir, func(r rune) bool { return r == '/' || r == '\\' }) {
				if p == ".." {
					return errors.New("service.source.rootDir cannot contain '..'")
				}
			}
		}
	default:
		return errors.New("service.source.type must be image or github")
	}
	if m.Service.Hostname != nil && *m.Service.Hostname == "" {
		return errors.New("service.hostname cannot be blank")
	}
	if m.Service.StartCommand != nil && *m.Service.StartCommand == "" {
		return errors.New("service.startCommand cannot be blank")
	}
	if m.Service.Replicas < 1 || m.Service.Replicas > 10 {
		return errors.New("service.replicas must be between 1 and 10")
	}
	if m.Service.Placement == nil {
		return errors.New("service.placement is required")
	}
	if p := m.Service.Placement; p != nil {
		switch p.Mode {
		case "automatic":
			if p.Servers != nil {
				return errors.New("service.placement.servers cannot be set for automatic placement")
			}
		case "manual":
			total := 0
			seen := make(map[string]struct{}, len(p.Servers))
			for i, server := range p.Servers {
				serverID := strings.TrimSpace(server.ServerID)
				if serverID == "" {
					return fmt.Errorf("service.placement.servers[%d].serverId cannot be blank", i)
				}
				if _, exists := seen[serverID]; exists {
					return fmt.Errorf("service.placement.servers[%d].serverId must be unique", i)
				}
				seen[serverID] = struct{}{}
				if server.Count < 1 {
					return fmt.Errorf("service.placement.servers[%d].count must be positive", i)
				}
				total += server.Count
			}
			if total < 1 || total > 10 {
				return errors.New("service.placement manual total must be between 1 and 10")
			}
			if total != m.Service.Replicas {
				return errors.New("service.placement manual total must equal service.replicas")
			}
		default:
			return errors.New("service.placement.mode must be automatic or manual")
		}
	}
	seenPorts := make(map[int]struct{}, len(m.Service.Ports))
	for i, p := range m.Service.Ports {
		if p.ContainerPort < 1 || p.ContainerPort > 65535 {
			return fmt.Errorf("service.ports[%d].containerPort must be between 1 and 65535", i)
		}
		if _, exists := seenPorts[p.ContainerPort]; exists {
			return fmt.Errorf("service.ports[%d].containerPort must be unique", i)
		}
		seenPorts[p.ContainerPort] = struct{}{}
		if p.Domain != nil && strings.TrimSpace(*p.Domain) == "" {
			return fmt.Errorf("service.ports[%d].domain cannot be blank", i)
		}
		if p.Public && p.Domain == nil {
			return fmt.Errorf("service.ports[%d].domain is required for public ports", i)
		}
		if !p.Public && p.Domain != nil {
			return fmt.Errorf("service.ports[%d].domain cannot be set for internal ports", i)
		}
	}
	if h := m.Service.HealthCheck; h != nil && (h.Cmd == "" || h.Interval < 1 || h.Timeout < 1 || h.Retries < 1 || h.StartPeriod < 0) {
		return errors.New("service.healthCheck contains invalid values")
	}
	if r := m.Service.Resources; r != nil {
		if (r.CPUCores == nil) != (r.MemoryMB == nil) {
			return errors.New("service.resources must set both cpuCores and memoryMb together")
		}
		if r.CPUCores != nil && (*r.CPUCores < 0.1 || *r.CPUCores > 64) {
			return errors.New("service.resources.cpuCores must be between 0.1 and 64")
		}
		if r.MemoryMB != nil && (*r.MemoryMB < 64 || *r.MemoryMB > 65536) {
			return errors.New("service.resources.memoryMb must be between 64 and 65536")
		}
	}
	return nil
}
func (m Manifest) Linked() bool {
	return m.Project.ID != "" && m.Environment.ID != "" && m.Service.ID != ""
}
func CanonicalGitHubRepository(value string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Hostname(), "github.com") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Port() != "" {
		return "", errors.New("must be an HTTPS github.com URL without credentials, query, or fragment")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 2 {
		return "", errors.New("must contain owner/repo")
	}
	if strings.HasSuffix(strings.ToLower(parts[1]), ".git") {
		parts[1] = parts[1][:len(parts[1])-4]
	}
	valid := regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
	if parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." || !valid.MatchString(parts[0]) || !valid.MatchString(parts[1]) || parts[1] == "" {
		return "", errors.New("invalid owner/repo path")
	}
	return "https://github.com/" + parts[0] + "/" + parts[1], nil
}

var slugChars = regexp.MustCompile(`[^a-z0-9]+`)

func Slugify(v string) string {
	return strings.Trim(slugChars.ReplaceAllString(strings.ToLower(v), "-"), "-")
}
