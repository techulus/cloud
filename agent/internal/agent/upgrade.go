package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/paths"
)

const (
	agentBinaryPath        = "/usr/local/bin/techulus-agent"
	agentPreviousPath      = "/usr/local/bin/techulus-agent.previous"
	agentUpgradeMarkerFile = "upgrade-pending.json"
	agentReleaseBaseURL    = "https://github.com/techulus/cloud/releases/download"
)

var (
	targetVersionPattern         = regexp.MustCompile(`^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)
	sha256Pattern                = regexp.MustCompile(`^[0-9a-f]{64}$`)
	errAgentUpgradeRestartNeeded = errors.New("agent upgrade restart needed")
)

type agentUpgradeMarker struct {
	TargetVersion string `json:"targetVersion"`
}

func CheckPendingUpgradeMarker(dataDir string) {
	marker, err := readAgentUpgradeMarker(dataDir)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("[upgrade] failed to read upgrade marker: %v", err)
		}
		return
	}

	if marker.TargetVersion == Version {
		if err := os.Remove(agentUpgradeMarkerPath(dataDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("[upgrade] failed to remove upgrade marker: %v", err)
		}
		log.Printf("[upgrade] completed upgrade to %s", Version)
		return
	}

	if _, err := os.Stat(agentPreviousPath); err != nil {
		log.Printf("[upgrade] pending upgrade to %s did not boot target version %s and no previous binary is available: %v", marker.TargetVersion, Version, err)
		if removeErr := os.Remove(agentUpgradeMarkerPath(dataDir)); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			log.Printf("[upgrade] failed to remove unrecoverable upgrade marker: %v", removeErr)
		}
		return
	}

	log.Printf("[upgrade] restoring previous binary after failed upgrade to %s (running %s)", marker.TargetVersion, Version)
	if err := copyFile(agentPreviousPath, agentBinaryPath, 0o755); err != nil {
		log.Printf("[upgrade] failed to restore previous binary: %v", err)
		return
	}
	if err := os.Chmod(agentBinaryPath, 0o755); err != nil {
		log.Printf("[upgrade] failed to chmod restored binary: %v", err)
		return
	}
	if err := os.Remove(agentUpgradeMarkerPath(dataDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("[upgrade] failed to remove upgrade marker after rollback: %v", err)
	}
	os.Exit(0)
}

func (a *Agent) ProcessAgentUpgrade(item agenthttp.WorkQueueItem) error {
	var payload struct {
		TargetVersion  string `json:"targetVersion"`
		ExpectedSHA256 string `json:"expectedSha256"`
	}

	if err := json.Unmarshal([]byte(item.Payload), &payload); err != nil {
		return fmt.Errorf("failed to parse upgrade_agent payload: %w", err)
	}

	targetVersion := strings.TrimSpace(payload.TargetVersion)
	if targetVersion == Version {
		log.Printf("[upgrade] already running target version %s", targetVersion)
		return nil
	}
	if !targetVersionPattern.MatchString(targetVersion) {
		return fmt.Errorf("invalid target version: %s", targetVersion)
	}
	if runtime.GOOS != "linux" {
		return fmt.Errorf("agent upgrades are only supported on linux")
	}
	arch := runtime.GOARCH
	if arch != "amd64" && arch != "arm64" {
		return fmt.Errorf("unsupported architecture: %s", arch)
	}
	expectedSHA256 := strings.ToLower(strings.TrimSpace(payload.ExpectedSHA256))
	if !sha256Pattern.MatchString(expectedSHA256) {
		return fmt.Errorf("expectedSha256 is required")
	}

	log.Printf("[upgrade] installing agent %s for linux/%s", targetVersion, arch)
	tmpPath := filepath.Join(filepath.Dir(agentBinaryPath), fmt.Sprintf(".techulus-agent-%s.tmp", targetVersion))
	defer os.Remove(tmpPath)

	assetURL := fmt.Sprintf("%s/%s/agent-linux-%s", agentReleaseBaseURL, targetVersion, arch)
	if err := downloadFile(assetURL, tmpPath); err != nil {
		return err
	}
	if err := verifySHA256(tmpPath, expectedSHA256); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return fmt.Errorf("failed to chmod new agent binary: %w", err)
	}

	if err := copyFile(agentBinaryPath, agentPreviousPath, 0o755); err != nil {
		return fmt.Errorf("failed to back up current agent binary: %w", err)
	}
	if err := os.Chmod(agentPreviousPath, 0o755); err != nil {
		return fmt.Errorf("failed to chmod backed up agent binary: %w", err)
	}
	if err := writeAgentUpgradeMarker(a.DataDir, targetVersion); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, agentBinaryPath); err != nil {
		return fmt.Errorf("failed to install new agent binary: %w", err)
	}

	log.Printf("[upgrade] installed %s; restart required", targetVersion)
	return errAgentUpgradeRestartNeeded
}

func agentUpgradeMarkerPath(dataDir string) string {
	if dataDir == "" {
		dataDir = paths.DataDir
	}
	return filepath.Join(dataDir, agentUpgradeMarkerFile)
}

func readAgentUpgradeMarker(dataDir string) (*agentUpgradeMarker, error) {
	data, err := os.ReadFile(agentUpgradeMarkerPath(dataDir))
	if err != nil {
		return nil, err
	}
	var marker agentUpgradeMarker
	if err := json.Unmarshal(data, &marker); err != nil {
		return nil, err
	}
	return &marker, nil
}

func writeAgentUpgradeMarker(dataDir, targetVersion string) error {
	data, err := json.Marshal(agentUpgradeMarker{TargetVersion: targetVersion})
	if err != nil {
		return err
	}
	return os.WriteFile(agentUpgradeMarkerPath(dataDir), data, 0o600)
}

func downloadFile(url, destPath string) error {
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("failed to download agent binary: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("agent binary download failed with status %d", resp.StatusCode)
	}

	file, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("failed to create temp agent binary: %w", err)
	}
	defer file.Close()
	if _, err := io.Copy(file, resp.Body); err != nil {
		return fmt.Errorf("failed to write temp agent binary: %w", err)
	}
	return nil
}

func verifySHA256(path, expected string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("failed to open downloaded agent binary: %w", err)
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return fmt.Errorf("failed to hash downloaded agent binary: %w", err)
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return fmt.Errorf("checksum verification failed")
	}
	return nil
}
