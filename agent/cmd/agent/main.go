package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/techulus/cloud-agent/internal/api"
	"github.com/techulus/cloud-agent/internal/crypto"
	"github.com/techulus/cloud-agent/internal/podman"
	"github.com/techulus/cloud-agent/internal/wireguard"
)

const (
	defaultDataDir      = "/var/lib/techulus-agent"
	defaultPollInterval = 10 * time.Second
	maxConsecutiveFails = 30
)

type Config struct {
	ServerID    string `json:"serverId"`
	WireGuardIP string `json:"wireguardIp"`
}

var isProxy bool

func main() {
	var (
		controlPlaneURL string
		token           string
		dataDir         string
		pollInterval    time.Duration
	)

	flag.StringVar(&controlPlaneURL, "url", "", "Control plane URL (required)")
	flag.StringVar(&token, "token", "", "Registration token (required for first run)")
	flag.StringVar(&dataDir, "data-dir", defaultDataDir, "Data directory for agent state")
	flag.DurationVar(&pollInterval, "poll-interval", defaultPollInterval, "Poll interval for status updates")
	flag.BoolVar(&isProxy, "proxy", false, "Enable proxy mode (handles Caddy sync)")
	flag.Parse()

	if controlPlaneURL == "" {
		log.Fatal("--url is required")
	}

	if err := wireguard.CheckPrerequisites(); err != nil {
		log.Fatalf("WireGuard prerequisites check failed: %v", err)
	}

	if err := podman.CheckPrerequisites(); err != nil {
		log.Fatalf("Podman prerequisites check failed: %v", err)
	}

	if err := os.MkdirAll(dataDir, 0700); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	keyDir := filepath.Join(dataDir, "keys")
	configPath := filepath.Join(dataDir, "config.json")

	client := api.NewClient(controlPlaneURL)

	var signingKeyPair *crypto.KeyPair
	var config *Config
	var err error

	if crypto.KeyPairExists(keyDir) {
		log.Println("Loading existing signing key pair...")
		signingKeyPair, err = crypto.LoadKeyPair(keyDir)
		if err != nil {
			log.Fatalf("Failed to load signing key pair: %v", err)
		}

		config, err = loadConfig(configPath)
		if err != nil {
			log.Fatalf("Failed to load config: %v", err)
		}

		log.Printf("Loaded config: serverID=%s, wireguardIP=%s", config.ServerID, config.WireGuardIP)
	} else {
		if token == "" {
			log.Fatal("--token is required for first-time registration")
		}

		log.Println("Generating signing key pair (Ed25519)...")
		signingKeyPair, err = crypto.GenerateKeyPair()
		if err != nil {
			log.Fatalf("Failed to generate signing key pair: %v", err)
		}

		if err := signingKeyPair.SaveToFile(keyDir); err != nil {
			log.Fatalf("Failed to save signing key pair: %v", err)
		}

		log.Println("Generating WireGuard key pair (Curve25519)...")
		wgPrivateKey, wgPublicKey, err := wireguard.GenerateKeyPair()
		if err != nil {
			log.Fatalf("Failed to generate WireGuard key pair: %v", err)
		}

		if err := wireguard.SavePrivateKey(dataDir, wgPrivateKey); err != nil {
			log.Fatalf("Failed to save WireGuard private key: %v", err)
		}

		log.Println("Registering with control plane...")
		publicIP := getPublicIP()
		resp, err := client.Register(token, wgPublicKey, signingKeyPair.PublicKeyBase64(), publicIP)
		if err != nil {
			log.Fatalf("Failed to register: %v", err)
		}

		config = &Config{
			ServerID:    resp.ServerID,
			WireGuardIP: resp.WireGuardIP,
		}

		if err := saveConfig(configPath, config); err != nil {
			log.Fatalf("Failed to save config: %v", err)
		}

		log.Printf("Registration successful! serverID=%s, wireguardIP=%s", config.ServerID, config.WireGuardIP)
		log.Printf("Received %d peers", len(resp.Peers))

		wgConfig := &wireguard.Config{
			PrivateKey: wgPrivateKey,
			Address:    config.WireGuardIP,
			ListenPort: wireguard.DefaultPort,
			Peers:      convertPeers(resp.Peers),
		}

		log.Println("Writing WireGuard config...")
		if err := wireguard.WriteConfig(wireguard.DefaultInterface, wgConfig); err != nil {
			log.Fatalf("Failed to write WireGuard config: %v", err)
		}

		log.Println("Bringing up WireGuard interface...")
		if err := wireguard.Up(wireguard.DefaultInterface); err != nil {
			log.Fatalf("Failed to bring up WireGuard: %v", err)
		}

		log.Println("WireGuard interface is up!")
	}

	client.SetServerID(config.ServerID)
	client.SetKeyPair(signingKeyPair)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	publicIP := getPublicIP()
	log.Printf("Agent started. Public IP: %s. Polling every %s...", publicIP, pollInterval)

	consecutiveFails := 0

	consecutiveFails = poll(client, dataDir, consecutiveFails, publicIP)

	for {
		select {
		case <-ticker.C:
			consecutiveFails = poll(client, dataDir, consecutiveFails, publicIP)
			if consecutiveFails >= maxConsecutiveFails {
				log.Fatalf("Too many consecutive failures (%d), shutting down", consecutiveFails)
			}
		case <-stop:
			log.Println("Shutting down...")
			return
		}
	}
}

func poll(client *api.Client, dataDir string, consecutiveFails int, publicIP string) int {
	resources := getSystemStats()
	containers := getContainerList()

	var proxyRoutes []api.ProxyRouteInfo
	if isProxy {
		proxyRoutes = getCaddyRoutes()
	}

	resp, err := client.SendStatus(resources, publicIP, containers, proxyRoutes)
	if err != nil {
		consecutiveFails++
		log.Printf("Status poll failed (%d/%d): %v", consecutiveFails, maxConsecutiveFails, err)
		return consecutiveFails
	}

	if resp.Work != nil {
		log.Printf("Received work: id=%s, type=%s", resp.Work.ID, resp.Work.Type)
		handleWork(client, resp.Work, dataDir)
	}

	return 0
}

func getContainerList() []api.ContainerInfo {
	podmanContainers, err := podman.ListContainers()
	if err != nil {
		log.Printf("Failed to list containers: %v", err)
		return nil
	}

	containers := make([]api.ContainerInfo, len(podmanContainers))
	for i, c := range podmanContainers {
		containers[i] = api.ContainerInfo{
			ID:      c.ID,
			Name:    c.Name,
			Image:   c.Image,
			State:   c.State,
			Created: c.Created,
		}
	}

	return containers
}

func handleWork(client *api.Client, work *api.Work, dataDir string) {
	log.Printf("Processing work %s (type: %s)", work.ID, work.Type)

	var status string = "completed"
	var logs string

	switch work.Type {
	case "deploy":
		result, err := handleDeploy(work)
		if err != nil {
			log.Printf("Deploy failed: %v", err)
			status = "failed"
			logs = err.Error()
		} else {
			logs = fmt.Sprintf("Container started: %s", result.ContainerID)
		}
	case "stop":
		if err := handleStop(work); err != nil {
			log.Printf("Stop failed: %v", err)
			status = "failed"
			logs = err.Error()
		}
	case "update_wireguard":
		if err := handleWireguardUpdate(work, dataDir); err != nil {
			log.Printf("WireGuard update failed: %v", err)
			status = "failed"
		}
	case "sync_caddy":
		if isProxy {
			if err := handleCaddySync(work); err != nil {
				log.Printf("Caddy sync failed: %v", err)
				status = "failed"
				logs = err.Error()
			} else {
				logs = "Caddy route synced"
			}
		} else {
			logs = "Skipped (not proxy)"
		}
	default:
		log.Printf("Unknown work type: %s", work.Type)
	}

	if err := client.CompleteWork(work.ID, status, logs); err != nil {
		log.Printf("Failed to complete work: %v", err)
	} else {
		log.Printf("Work %s completed with status: %s", work.ID, status)
	}
}

func handleDeploy(work *api.Work) (*podman.DeployResult, error) {
	var payload struct {
		DeploymentID string `json:"deploymentId"`
		ServiceID    string `json:"serviceId"`
		Image        string `json:"image"`
		PortMappings []struct {
			ContainerPort int `json:"containerPort"`
			HostPort      int `json:"hostPort"`
		} `json:"portMappings"`
		WireGuardIP string `json:"wireguardIp"`
		Name        string `json:"name"`
	}

	if err := json.Unmarshal(work.Payload, &payload); err != nil {
		return nil, fmt.Errorf("failed to parse payload: %w", err)
	}

	portMappings := make([]podman.PortMapping, len(payload.PortMappings))
	for i, pm := range payload.PortMappings {
		portMappings[i] = podman.PortMapping{
			ContainerPort: pm.ContainerPort,
			HostPort:      pm.HostPort,
		}
	}

	log.Printf("Deploying %s (image: %s, ports: %d mappings)", payload.Name, payload.Image, len(portMappings))

	result, err := podman.Deploy(&podman.DeployConfig{
		Name:         payload.Name,
		Image:        payload.Image,
		WireGuardIP:  payload.WireGuardIP,
		PortMappings: portMappings,
	})
	if err != nil {
		return nil, err
	}

	log.Printf("Container %s started successfully", result.ContainerID)
	return result, nil
}

func handleStop(work *api.Work) error {
	var payload struct {
		ContainerID string `json:"containerId"`
	}

	if err := json.Unmarshal(work.Payload, &payload); err != nil {
		return fmt.Errorf("failed to parse payload: %w", err)
	}

	log.Printf("Stopping container %s", payload.ContainerID)

	if err := podman.Stop(payload.ContainerID); err != nil {
		return err
	}

	log.Printf("Container %s stopped successfully", payload.ContainerID)
	return nil
}

func handleWireguardUpdate(work *api.Work, dataDir string) error {
	var payload struct {
		Peers []api.Peer `json:"peers"`
	}

	if err := json.Unmarshal(work.Payload, &payload); err != nil {
		return err
	}

	wgPrivateKey, err := wireguard.LoadPrivateKey(dataDir)
	if err != nil {
		return err
	}

	configPath := filepath.Join(dataDir, "config.json")
	config, err := loadConfig(configPath)
	if err != nil {
		return err
	}

	wgConfig := &wireguard.Config{
		PrivateKey: wgPrivateKey,
		Address:    config.WireGuardIP,
		ListenPort: wireguard.DefaultPort,
		Peers:      convertPeers(payload.Peers),
	}

	if err := wireguard.WriteConfig(wireguard.DefaultInterface, wgConfig); err != nil {
		return err
	}

	return wireguard.Reload(wireguard.DefaultInterface)
}

func handleCaddySync(work *api.Work) error {
	var payload struct {
		Action string          `json:"action"`
		Domain string          `json:"domain"`
		Route  json.RawMessage `json:"route"`
	}

	if err := json.Unmarshal(work.Payload, &payload); err != nil {
		return fmt.Errorf("failed to parse payload: %w", err)
	}

	log.Printf("Syncing Caddy route for %s (action: %s)", payload.Domain, payload.Action)

	caddyURL := "http://localhost:2019"

	if payload.Action == "delete" {
		req, err := http.NewRequest("DELETE", caddyURL+"/id/"+payload.Domain, nil)
		if err != nil {
			return err
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()

		persistResp, _ := http.Post(caddyURL+"/config/persist", "application/json", nil)
		if persistResp != nil {
			persistResp.Body.Close()
		}
		return nil
	}

	req, err := http.NewRequest("PUT", caddyURL+"/id/"+payload.Domain, strings.NewReader(string(payload.Route)))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to sync route: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 404 {
		postResp, err := http.Post(
			caddyURL+"/config/apps/http/servers/srv0/routes",
			"application/json",
			strings.NewReader(string(payload.Route)),
		)
		if err != nil {
			return fmt.Errorf("failed to create route: %w", err)
		}
		defer postResp.Body.Close()

		if postResp.StatusCode >= 400 {
			body, _ := io.ReadAll(postResp.Body)
			return fmt.Errorf("caddy returned error on create: %s", string(body))
		}
	} else if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("caddy returned error: %s", string(body))
	}

	persistResp, err := http.Post(caddyURL+"/config/persist", "application/json", nil)
	if err != nil {
		log.Printf("Warning: failed to persist Caddy config: %v", err)
	} else {
		persistResp.Body.Close()
	}

	log.Printf("Caddy route synced for %s", payload.Domain)
	return nil
}

func convertPeers(apiPeers []api.Peer) []wireguard.Peer {
	peers := make([]wireguard.Peer, len(apiPeers))
	for i, p := range apiPeers {
		peers[i] = wireguard.Peer{
			PublicKey:  p.PublicKey,
			AllowedIPs: p.AllowedIPs,
			Endpoint:   p.Endpoint,
		}
	}
	return peers
}

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

func saveConfig(path string, config *Config) error {
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

func getSystemStats() *api.Resources {
	resources := &api.Resources{}

	resources.CpuCores = runtime.NumCPU()

	memInfo, err := mem.VirtualMemory()
	if err == nil {
		resources.MemoryTotalMB = int(memInfo.Total / 1024 / 1024)
	}

	diskInfo, err := disk.Usage("/")
	if err == nil {
		resources.DiskTotalGB = int(diskInfo.Total / 1024 / 1024 / 1024)
	}

	return resources
}

func getPublicIP() string {
	resp, err := http.Get("https://api.ipify.org")
	if err != nil {
		log.Printf("Failed to get public IP: %v", err)
		return ""
	}
	defer resp.Body.Close()

	ip, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Failed to read public IP response: %v", err)
		return ""
	}

	return strings.TrimSpace(string(ip))
}

func getCaddyRoutes() []api.ProxyRouteInfo {
	resp, err := http.Get("http://localhost:2019/config/apps/http/servers/srv0/routes")
	if err != nil {
		log.Printf("Failed to get Caddy routes: %v", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Failed to read Caddy routes response: %v", err)
		return nil
	}

	var routes []struct {
		ID     string `json:"@id"`
		Match  []struct {
			Host []string `json:"host"`
		} `json:"match"`
		Handle []struct {
			Handler   string `json:"handler"`
			Upstreams []struct {
				Dial string `json:"dial"`
			} `json:"upstreams"`
		} `json:"handle"`
	}

	if err := json.Unmarshal(body, &routes); err != nil {
		log.Printf("Failed to parse Caddy routes: %v", err)
		return nil
	}

	var proxyRoutes []api.ProxyRouteInfo
	for _, route := range routes {
		if route.ID == "" {
			continue
		}

		var domain string
		if len(route.Match) > 0 && len(route.Match[0].Host) > 0 {
			domain = route.Match[0].Host[0]
		}

		var upstreams []string
		for _, handle := range route.Handle {
			if handle.Handler == "reverse_proxy" {
				for _, upstream := range handle.Upstreams {
					upstreams = append(upstreams, upstream.Dial)
				}
			}
		}

		proxyRoutes = append(proxyRoutes, api.ProxyRouteInfo{
			RouteID:   route.ID,
			Domain:    domain,
			Upstreams: upstreams,
		})
	}

	return proxyRoutes
}
