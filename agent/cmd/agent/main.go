package main

import (
	"context"
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

	"techulus/cloud-agent/internal/api"
	"techulus/cloud-agent/internal/caddy"
	"techulus/cloud-agent/internal/crypto"
	"techulus/cloud-agent/internal/dns"
	agentgrpc "techulus/cloud-agent/internal/grpc"
	"techulus/cloud-agent/internal/podman"
	pb "techulus/cloud-agent/internal/proto"
	"techulus/cloud-agent/internal/wireguard"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
)

const (
	defaultDataDir = "/var/lib/techulus-agent"
)

type Config struct {
	ServerID    string `json:"serverId"`
	SubnetID    int    `json:"subnetId"`
	WireGuardIP string `json:"wireguardIp"`
}

var httpClient *api.Client
var dataDir string

func main() {
	var (
		controlPlaneURL string
		token           string
		grpcURL         string
		grpcTLS         bool
	)

	flag.StringVar(&controlPlaneURL, "url", "", "Control plane URL (required)")
	flag.StringVar(&token, "token", "", "Registration token (required for first run)")
	flag.StringVar(&dataDir, "data-dir", defaultDataDir, "Data directory for agent state")
	flag.StringVar(&grpcURL, "grpc-url", "", "gRPC server URL (e.g., 100.0.0.1:50051)")
	flag.BoolVar(&grpcTLS, "grpc-tls", false, "Use TLS for gRPC connection")
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

	if err := caddy.CheckPrerequisites(); err != nil {
		log.Fatalf("Caddy prerequisites check failed: %v", err)
	}

	if err := os.MkdirAll(dataDir, 0700); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	keyDir := filepath.Join(dataDir, "keys")
	configPath := filepath.Join(dataDir, "config.json")

	httpClient = api.NewClient(controlPlaneURL)

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

		log.Printf("Loaded config: serverID=%s, subnetId=%d, wireguardIP=%s", config.ServerID, config.SubnetID, config.WireGuardIP)

		if err := dns.SetupLocalDNS(config.WireGuardIP); err != nil {
			log.Printf("Warning: Failed to setup local DNS: %v", err)
		}

		if err := podman.EnsureNetwork(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to ensure container network: %v", err)
		}
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
		resp, err := httpClient.Register(token, wgPublicKey, signingKeyPair.PublicKeyBase64(), publicIP)
		if err != nil {
			log.Fatalf("Failed to register: %v", err)
		}

		config = &Config{
			ServerID:    resp.ServerID,
			SubnetID:    resp.SubnetID,
			WireGuardIP: resp.WireGuardIP,
		}

		if err := saveConfig(configPath, config); err != nil {
			log.Fatalf("Failed to save config: %v", err)
		}

		log.Printf("Registration successful! serverID=%s, subnetId=%d, wireguardIP=%s", config.ServerID, config.SubnetID, config.WireGuardIP)
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

		log.Println("Setting up local DNS (dnsmasq)...")
		if err := dns.SetupLocalDNS(config.WireGuardIP); err != nil {
			log.Printf("Warning: Failed to setup local DNS: %v", err)
		} else {
			log.Println("Local DNS configured successfully")
		}

		log.Println("Ensuring container network exists...")
		if err := podman.EnsureNetwork(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to create container network: %v", err)
		} else {
			log.Println("Container network ready")
		}
	}

	grpcAddress := grpcURL
	if grpcAddress == "" {
		log.Fatal("--grpc-url is required")
	}
	log.Printf("Connecting to gRPC server at %s (TLS: %v)...", grpcAddress, grpcTLS)

	grpcClient := agentgrpc.NewClient(grpcAddress, config.ServerID, signingKeyPair, grpcTLS)
	grpcClient.SetWorkHandler(handleWork)
	grpcClient.SetCaddyHandler(caddy.HandleCaddyConfig)
	grpcClient.SetDnsHandler(handleDnsConfig)

	ctx, cancel := context.WithCancel(context.Background())

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-stop
		log.Println("Shutting down...")
		cancel()
	}()

	publicIP := getPublicIP()
	log.Printf("Agent started. Public IP: %s. Using gRPC streaming...", publicIP)

	grpcClient.RunWithReconnect(ctx, func(includeResources bool) *agentgrpc.StatusData {
		return getStatusData(publicIP, includeResources)
	})

	grpcClient.Close()
	log.Println("Agent stopped")
}

func getStatusData(publicIP string, includeResources bool) *agentgrpc.StatusData {
	var resources *pb.Resources
	if includeResources {
		resources = getSystemStats()
	}

	return &agentgrpc.StatusData{
		Resources: resources,
		PublicIP:  publicIP,
	}
}

func handleWork(work *pb.WorkItem) (status string, logs string) {
	log.Printf("Processing work %s (type: %s)", work.Id, work.Type)

	status = "completed"

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
		if err := handleWireguardUpdate(work); err != nil {
			log.Printf("WireGuard update failed: %v", err)
			status = "failed"
		}
	case "sync_caddy":
		logs = "Deprecated - using reconciliation"
	default:
		log.Printf("Unknown work type: %s", work.Type)
	}

	log.Printf("Work %s completed with status: %s", work.Id, status)
	return status, logs
}

func handleDeploy(work *pb.WorkItem) (*podman.DeployResult, error) {
	var payload struct {
		DeploymentID string `json:"deploymentId"`
		ServiceID    string `json:"serviceId"`
		Image        string `json:"image"`
		PortMappings []struct {
			ContainerPort int `json:"containerPort"`
			HostPort      int `json:"hostPort"`
		} `json:"portMappings"`
		WireGuardIP string `json:"wireguardIp"`
		IPAddress   string `json:"ipAddress"`
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

	log.Printf("Deploying %s (image: %s, ip: %s, ports: %d mappings)", payload.Name, payload.Image, payload.IPAddress, len(portMappings))

	result, err := podman.Deploy(&podman.DeployConfig{
		Name:         payload.Name,
		Image:        payload.Image,
		WireGuardIP:  payload.WireGuardIP,
		IPAddress:    payload.IPAddress,
		PortMappings: portMappings,
	})
	if err != nil {
		return nil, err
	}

	log.Printf("Container %s started successfully", result.ContainerID)
	return result, nil
}

func handleStop(work *pb.WorkItem) error {
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

func handleWireguardUpdate(work *pb.WorkItem) error {
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

func handleDnsConfig(config *pb.DnsConfig) {
	log.Printf("Updating DNS records (%d records)", len(config.Records))
	if err := dns.UpdateRecords(config); err != nil {
		log.Printf("Failed to update DNS records: %v", err)
	} else {
		log.Printf("DNS records updated successfully")
	}
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

func getSystemStats() *pb.Resources {
	resources := &pb.Resources{}

	resources.CpuCores = int32(runtime.NumCPU())

	memInfo, err := mem.VirtualMemory()
	if err == nil {
		resources.MemoryTotalMb = int32(memInfo.Total / 1024 / 1024)
	}

	diskInfo, err := disk.Usage("/")
	if err == nil {
		resources.DiskTotalGb = int32(diskInfo.Total / 1024 / 1024 / 1024)
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
