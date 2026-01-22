package main

import (
	"context"
	"encoding/json"
	"flag"
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

	"techulus/cloud-agent/internal/agent"
	"techulus/cloud-agent/internal/api"
	"techulus/cloud-agent/internal/build"
	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/crypto"
	"techulus/cloud-agent/internal/dns"
	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/logs"
	"techulus/cloud-agent/internal/paths"
	"techulus/cloud-agent/internal/reconcile"
	"techulus/cloud-agent/internal/traefik"
	"techulus/cloud-agent/internal/wireguard"

	"github.com/hashicorp/go-sockaddr"
)

var httpClient *api.Client
var dataDir string

func main() {
	var (
		controlPlaneURL  string
		token            string
		isProxy          bool
		logsEndpointFlag string
	)

	flag.StringVar(&controlPlaneURL, "url", "", "Control plane URL (required)")
	flag.StringVar(&token, "token", "", "Registration token (required for first run)")
	flag.StringVar(&dataDir, "data-dir", paths.DataDir, "Data directory for agent state")
	flag.BoolVar(&isProxy, "proxy", false, "Run as proxy node (handles TLS and public traffic)")
	flag.StringVar(&logsEndpointFlag, "logs-endpoint", "", "Override logs endpoint URL (optional)")
	flag.Parse()

	if controlPlaneURL == "" {
		log.Fatal("--url is required")
	}

	var logsEndpoint string
	if logsEndpointFlag != "" {
		logsEndpoint = logsEndpointFlag
	} else {
		logsEndpoint = fetchLogsEndpoint(controlPlaneURL)
	}

	if isProxy && runtime.GOOS != "linux" {
		log.Fatal("--proxy flag is only supported on Linux")
	}

	if err := wireguard.CheckPrerequisites(); err != nil {
		log.Fatalf("WireGuard prerequisites check failed: %v", err)
	}

	if err := container.CheckPrerequisites(); err != nil {
		log.Fatalf("Container runtime prerequisites check failed: %v", err)
	}

	if isProxy {
		if err := traefik.CheckPrerequisites(); err != nil {
			log.Fatalf("Traefik prerequisites check failed: %v", err)
		}
		log.Println("Running as proxy node - Traefik will handle public traffic")
	} else {
		log.Println("Running as worker node - Traefik disabled")
	}

	if err := build.CheckPrerequisites(); err != nil {
		log.Fatalf("Build prerequisites check failed: %v", err)
	}

	if err := os.MkdirAll(dataDir, 0700); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	keyDir := filepath.Join(dataDir, "keys")
	configPath := filepath.Join(dataDir, "config.json")

	httpClient = api.NewClient(controlPlaneURL)

	var signingKeyPair *crypto.KeyPair
	var config *agent.Config
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

		if err := container.EnsureNetwork(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to ensure container network: %v", err)
		}

		if err := dns.SetupLocalDNS(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to setup local DNS: %v", err)
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
		privateIP := getPrivateIP()
		resp, err := httpClient.Register(token, wgPublicKey, signingKeyPair.PublicKeyBase64(), publicIP, privateIP, isProxy)
		if err != nil {
			log.Fatalf("Failed to register: %v", err)
		}

		config = &agent.Config{
			ServerID:      resp.ServerID,
			SubnetID:      resp.SubnetID,
			WireGuardIP:   resp.WireGuardIP,
			EncryptionKey: resp.EncryptionKey,
			IsProxy:       isProxy,
		}

		if err := saveConfig(configPath, config); err != nil {
			log.Fatalf("Failed to save config: %v", err)
		}

		log.Printf("Registration successful! serverID=%s, subnetId=%d, wireguardIP=%s", config.ServerID, config.SubnetID, config.WireGuardIP)

		wgConfig := &wireguard.Config{
			PrivateKey: wgPrivateKey,
			Address:    config.WireGuardIP,
			ListenPort: wireguard.DefaultPort,
			MTU:        1420,
			Peers:      []wireguard.Peer{},
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

		log.Println("Ensuring container network exists...")
		if err := container.EnsureNetwork(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to create container network: %v", err)
		} else {
			log.Println("Container network ready")
		}

		log.Println("Setting up local DNS...")
		if err := dns.SetupLocalDNS(config.SubnetID); err != nil {
			log.Printf("Warning: Failed to setup local DNS: %v", err)
		} else {
			log.Println("Local DNS configured successfully")
		}
	}

	reconciler := reconcile.NewReconciler(config.EncryptionKey, dataDir)
	client := agenthttp.NewClient(controlPlaneURL, config.ServerID, signingKeyPair, dataDir)

	var logCollector *logs.Collector
	var traefikLogCollector *logs.TraefikCollector
	var logsSender *logs.VictoriaLogsSender
	var agentLogWriter *logs.AgentLogWriter
	if logsEndpoint != "" {
		log.Println("[logs] log collection enabled, endpoint:", logsEndpoint)
		logsSender = logs.NewVictoriaLogsSender(logsEndpoint, config.ServerID)
		logCollector = logs.NewCollector(logsSender, dataDir)
		if isProxy {
			traefikLogCollector = logs.NewTraefikCollector(logsSender)
			log.Println("[traefik-logs] Traefik HTTP log collection enabled")
		}
		agentLogWriter = logs.NewAgentLogWriter(config.ServerID, logsSender)
		log.SetOutput(agentLogWriter)
		log.Println("[agent-logs] Agent log collection enabled")
	}

	var builder *build.Builder
	if logsSender != nil {
		builder = build.NewBuilder(dataDir, logsSender)
		log.Println("[build] build system enabled")
	} else {
		builder = build.NewBuilder(dataDir, nil)
		log.Println("[build] build system enabled (no log streaming)")
	}

	ctx, cancel := context.WithCancel(context.Background())

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-stop
		log.Println("Shutting down...")
		cancel()
	}()

	var agentLogFlusherDone <-chan struct{}
	if agentLogWriter != nil {
		agentLogFlusherDone = agentLogWriter.StartFlusher(ctx)
	}

	publicIP := getPublicIP()
	privateIP := getPrivateIP()
	log.Printf("Agent started. Public IP: %s, Private IP: %s. Tick interval: %v", publicIP, privateIP, agent.TickInterval)

	agentInstance := agent.NewAgent(client, reconciler, config, publicIP, privateIP, dataDir, logCollector, traefikLogCollector, builder, config.IsProxy)
	agentInstance.Run(ctx)

	if agentLogFlusherDone != nil {
		<-agentLogFlusherDone
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := dns.StopDNSServer(shutdownCtx); err != nil {
		log.Printf("[dns] shutdown error: %v", err)
	}

	log.Println("Agent stopped")
}

func loadConfig(path string) (*agent.Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var config agent.Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

func saveConfig(path string, config *agent.Config) error {
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

func getPublicIP() string {
	ip, err := sockaddr.GetPublicIP()
	if err == nil && ip != "" {
		return ip
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("https://api.ipify.org")
	if err != nil {
		log.Printf("Failed to get public IP from ipify: %v", err)
		return ""
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Failed to read ipify response: %v", err)
		return ""
	}

	return strings.TrimSpace(string(body))
}

func getPrivateIP() string {
	ips, err := sockaddr.GetPrivateIPs()
	if err != nil {
		log.Printf("Failed to get private IPs: %v", err)
		return ""
	}

	for _, ip := range strings.Split(ips, " ") {
		if ip == "" {
			continue
		}
		if strings.HasPrefix(ip, "10.100.") || strings.HasPrefix(ip, "10.200.") {
			continue
		}
		return ip
	}

	return ""
}

type discoverResponse struct {
	LoggingEndpoint *string `json:"loggingEndpoint"`
	Version         int     `json:"version"`
}

func fetchLogsEndpoint(controlPlaneURL string) string {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(controlPlaneURL + "/api/v1/agent/discover")
	if err != nil {
		log.Printf("Failed to fetch discovery endpoint: %v", err)
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Discovery endpoint returned status %d", resp.StatusCode)
		return ""
	}

	var discovery discoverResponse
	if err := json.NewDecoder(resp.Body).Decode(&discovery); err != nil {
		log.Printf("Failed to decode discovery response: %v", err)
		return ""
	}

	if discovery.LoggingEndpoint == nil {
		return ""
	}

	return *discovery.LoggingEndpoint
}
