package wireguard

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	DefaultInterface = "wg0"
	DefaultPort      = 51820
	ConfigDir        = "/etc/wireguard"
)

type Peer struct {
	PublicKey  string
	AllowedIPs string
	Endpoint   *string
}

type Config struct {
	PrivateKey string
	Address    string
	ListenPort int
	Peers      []Peer
}

func GenerateKeyPair() (privateKey, publicKey string, err error) {
	privCmd := exec.Command("wg", "genkey")
	privOut, err := privCmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("failed to generate private key: %w", err)
	}
	privateKey = strings.TrimSpace(string(privOut))

	pubCmd := exec.Command("wg", "pubkey")
	pubCmd.Stdin = strings.NewReader(privateKey)
	pubOut, err := pubCmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("failed to derive public key: %w", err)
	}
	publicKey = strings.TrimSpace(string(pubOut))

	return privateKey, publicKey, nil
}

func (c *Config) GenerateConfigFile() string {
	var sb strings.Builder

	sb.WriteString("[Interface]\n")
	sb.WriteString(fmt.Sprintf("PrivateKey = %s\n", c.PrivateKey))
	sb.WriteString(fmt.Sprintf("Address = %s/32\n", c.Address))
	sb.WriteString(fmt.Sprintf("ListenPort = %d\n", c.ListenPort))

	for _, peer := range c.Peers {
		sb.WriteString("\n[Peer]\n")
		sb.WriteString(fmt.Sprintf("PublicKey = %s\n", peer.PublicKey))
		sb.WriteString(fmt.Sprintf("AllowedIPs = %s\n", peer.AllowedIPs))
		if peer.Endpoint != nil && *peer.Endpoint != "" {
			sb.WriteString(fmt.Sprintf("Endpoint = %s\n", *peer.Endpoint))
		}
		sb.WriteString("PersistentKeepalive = 25\n")
	}

	return sb.String()
}

func WriteConfig(interfaceName string, config *Config) error {
	if err := os.MkdirAll(ConfigDir, 0700); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	configPath := filepath.Join(ConfigDir, interfaceName+".conf")
	content := config.GenerateConfigFile()

	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		return fmt.Errorf("failed to write config file: %w", err)
	}

	return nil
}

func Up(interfaceName string) error {
	cmd := exec.Command("wg-quick", "up", interfaceName)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to bring up interface: %w", err)
	}
	return nil
}

func Down(interfaceName string) error {
	cmd := exec.Command("wg-quick", "down", interfaceName)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to bring down interface: %w", err)
	}
	return nil
}

func IsUp(interfaceName string) bool {
	cmd := exec.Command("wg", "show", interfaceName)
	return cmd.Run() == nil
}

func Reload(interfaceName string) error {
	if IsUp(interfaceName) {
		if err := Down(interfaceName); err != nil {
			return err
		}
	}
	return Up(interfaceName)
}

func CheckPrerequisites() error {
	if _, err := exec.LookPath("wg"); err != nil {
		return fmt.Errorf("wg command not found: %w", err)
	}
	if _, err := exec.LookPath("wg-quick"); err != nil {
		return fmt.Errorf("wg-quick command not found: %w", err)
	}
	return nil
}

func SavePrivateKey(dataDir, privateKey string) error {
	path := filepath.Join(dataDir, "wireguard.key")
	return os.WriteFile(path, []byte(privateKey), 0600)
}

func LoadPrivateKey(dataDir string) (string, error) {
	path := filepath.Join(dataDir, "wireguard.key")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func PrivateKeyExists(dataDir string) bool {
	path := filepath.Join(dataDir, "wireguard.key")
	_, err := os.Stat(path)
	return err == nil
}
