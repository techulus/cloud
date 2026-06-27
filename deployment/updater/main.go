package main

import (
	"bufio"
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type updaterStatus struct {
	Status        string   `json:"status"`
	TargetVersion string   `json:"targetVersion"`
	StartedAt     string   `json:"startedAt"`
	CompletedAt   string   `json:"completedAt"`
	Error         string   `json:"error"`
	Logs          []string `json:"logs"`
}

type server struct {
	deployDir  string
	token      string
	rawBaseURL string
	healthURL  string
	statusFile string

	mu     sync.Mutex
	status updaterStatus
}

var versionPattern = regexp.MustCompile(`^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)

func main() {
	deployDir := getenv("DEPLOY_DIR", "/opt/techulus-cloud")
	s := &server{
		deployDir:  deployDir,
		token:      os.Getenv("CONTROL_PLANE_UPDATER_TOKEN"),
		rawBaseURL: getenv("RAW_BASE_URL", "https://raw.githubusercontent.com/techulus/cloud"),
		healthURL:  getenv("WEB_HEALTH_URL", "http://web:3000/api/health"),
		statusFile: filepath.Join(deployDir, "updater-status.json"),
	}
	s.status = s.readStatus()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/upgrade", s.handleUpgrade)

	addr := ":" + getenv("PORT", "8080")
	log.Printf("control plane updater listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func (s *server) readStatus() updaterStatus {
	data, err := os.ReadFile(s.statusFile)
	if err != nil {
		return updaterStatus{Status: "idle", Logs: []string{}}
	}

	var status updaterStatus
	if err := json.Unmarshal(data, &status); err != nil {
		log.Printf("failed to read updater status: %v", err)
		return updaterStatus{Status: "idle", Logs: []string{}}
	}
	if status.Status == "" {
		status.Status = "idle"
	}
	if status.Logs == nil {
		status.Logs = []string{}
	}
	return status
}

func (s *server) persistStatusLocked() {
	data, err := json.MarshalIndent(s.status, "", "  ")
	if err != nil {
		log.Printf("failed to marshal updater status: %v", err)
		return
	}
	if err := os.WriteFile(s.statusFile, data, 0o600); err != nil {
		log.Printf("failed to persist updater status: %v", err)
	}
}

func (s *server) patchStatus(update func(*updaterStatus)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	update(&s.status)
	s.persistStatusLocked()
}

func (s *server) logf(format string, args ...any) {
	line := fmt.Sprintf("[%s] %s", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
	s.mu.Lock()
	s.status.Logs = append(s.status.Logs, line)
	if len(s.status.Logs) > 200 {
		s.status.Logs = s.status.Logs[len(s.status.Logs)-200:]
	}
	s.persistStatusLocked()
	s.mu.Unlock()
	log.Print(line)
}

func (s *server) authorize(w http.ResponseWriter, r *http.Request) bool {
	if s.token == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Updater token is not configured"})
		return false
	}

	expected := "Bearer " + s.token
	actual := r.Header.Get("Authorization")
	if len(actual) != len(expected) || subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
		return false
	}
	return true
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	if !s.authorize(w, r) {
		return
	}

	s.mu.Lock()
	status := s.status
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, status)
}

func (s *server) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
		return
	}
	if !s.authorize(w, r) {
		return
	}

	var request struct {
		TargetVersion string `json:"targetVersion"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if request.TargetVersion == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "targetVersion is required"})
		return
	}

	s.mu.Lock()
	if s.status.Status == "running" {
		status := s.status
		s.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Upgrade already running", "status": status})
		return
	}
	s.status = updaterStatus{
		Status:        "running",
		TargetVersion: request.TargetVersion,
		StartedAt:     time.Now().UTC().Format(time.RFC3339),
		Logs:          []string{},
	}
	s.persistStatusLocked()
	status := s.status
	s.mu.Unlock()

	go s.upgrade(request.TargetVersion)
	writeJSON(w, http.StatusAccepted, status)
}

func writeJSON(w http.ResponseWriter, statusCode int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("failed to write response: %v", err)
	}
}

func parseEnv(path string) (map[string]string, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}

	env := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		env[parts[0]] = parts[1]
	}
	return env, string(data), nil
}

func updateEnvVersion(envPath, text, targetVersion string) error {
	lines := strings.Split(strings.TrimRight(text, "\r\n"), "\n")
	found := false
	for i, line := range lines {
		if strings.HasPrefix(line, "TECHULUS_CLOUD_VERSION=") {
			lines[i] = "TECHULUS_CLOUD_VERSION=" + targetVersion
			found = true
			break
		}
	}
	if !found {
		lines = append(lines, "TECHULUS_CLOUD_VERSION="+targetVersion)
	}
	return os.WriteFile(envPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
}

func (s *server) upgrade(targetVersion string) {
	var backupDir string
	composeFile := "compose.production.yml"
	migrationStarted := false

	if err := s.runUpgrade(targetVersion, &backupDir, &composeFile, &migrationStarted); err != nil {
		s.patchStatus(func(status *updaterStatus) {
			status.Status = "failed"
			status.CompletedAt = time.Now().UTC().Format(time.RFC3339)
			status.Error = err.Error()
		})
		s.logf("upgrade failed: %v", err)

		if backupDir != "" && !migrationStarted {
			if rollbackErr := s.restoreFiles(backupDir, composeFile); rollbackErr != nil {
				s.logf("rollback attempt failed: %v", rollbackErr)
			}
		} else if backupDir != "" {
			s.logf("migration had started; automatic image rollback skipped. Restore the database dump from %s before rolling back images.", backupDir)
		}
		return
	}

	s.patchStatus(func(status *updaterStatus) {
		status.Status = "succeeded"
		status.CompletedAt = time.Now().UTC().Format(time.RFC3339)
	})
	s.logf("upgrade to %s completed", targetVersion)
}

func (s *server) runUpgrade(targetVersion string, backupDir *string, composeFile *string, migrationStarted *bool) error {
	// The web app validates this against the persisted latest GitHub release
	// before calling the internal-only updater. Keep a local format guard here
	// so the value is safe to use in URLs and compose environment updates.
	if !versionPattern.MatchString(targetVersion) {
		return errors.New("invalid target version")
	}

	envPath := filepath.Join(s.deployDir, ".env")
	env, envText, err := parseEnv(envPath)
	if err != nil {
		return fmt.Errorf("%s not found: %w", envPath, err)
	}

	if value := env["COMPOSE_FILE"]; value != "" {
		*composeFile = value
	}
	*backupDir = filepath.Join(s.deployDir, "backups", "update-"+strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format(time.RFC3339Nano)))
	if err := os.MkdirAll(*backupDir, 0o700); err != nil {
		return err
	}

	s.logf("backing up deployment files to %s", *backupDir)
	if err := copyFile(envPath, filepath.Join(*backupDir, ".env")); err != nil {
		return err
	}
	for _, file := range []string{"compose.production.yml", "compose.postgres.yml"} {
		source := filepath.Join(s.deployDir, file)
		if _, err := os.Stat(source); err == nil {
			if err := copyFile(source, filepath.Join(*backupDir, file)); err != nil {
				return err
			}
		}
	}
	if err := s.backupDatabase(env, *backupDir); err != nil {
		return err
	}

	s.logf("downloading compose files for %s", targetVersion)
	if err := s.run("curl", []string{"-fsSL", fmt.Sprintf("%s/%s/deployment/compose.production.yml", s.rawBaseURL, targetVersion), "-o", "compose.production.yml"}, nil); err != nil {
		return err
	}
	if err := s.run("curl", []string{"-fsSL", fmt.Sprintf("%s/%s/deployment/compose.postgres.yml", s.rawBaseURL, targetVersion), "-o", "compose.postgres.yml"}, nil); err != nil {
		return err
	}
	if err := updateEnvVersion(envPath, envText, targetVersion); err != nil {
		return err
	}

	if err := s.run("docker", []string{"compose", "-f", *composeFile, "pull"}, nil); err != nil {
		return err
	}
	*migrationStarted = true
	if err := s.run("docker", []string{"compose", "-f", *composeFile, "up", "-d", "--force-recreate", "migrate"}, nil); err != nil {
		return err
	}

	services, err := s.composeServices(*composeFile)
	if err != nil {
		return err
	}
	if len(services) > 0 {
		args := append([]string{"compose", "-f", *composeFile, "up", "-d", "--remove-orphans"}, services...)
		if err := s.run("docker", args, nil); err != nil {
			return err
		}
	}
	return s.pollHealth()
}

func copyFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()

	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer output.Close()

	_, err = io.Copy(output, input)
	return err
}

func (s *server) backupDatabase(env map[string]string, backupDir string) error {
	databaseURL := env["DATABASE_URL"]
	if databaseURL == "" {
		s.logf("DATABASE_URL not found; skipping database dump")
		return nil
	}
	dumpPath := filepath.Join(backupDir, "database.dump")
	if err := s.run("pg_dump", []string{databaseURL, "-Fc", "-f", dumpPath}, []string{"[DATABASE_URL redacted]", "-Fc", "-f", dumpPath}); err != nil {
		return err
	}
	s.logf("database dump written to %s", dumpPath)
	return nil
}

func (s *server) composeServices(composeFile string) ([]string, error) {
	output, err := s.runOutput("docker", []string{"compose", "-f", composeFile, "config", "--services"})
	if err != nil {
		return nil, err
	}

	var services []string
	for _, line := range strings.Split(output, "\n") {
		service := strings.TrimSpace(line)
		if service == "" || service == "control-plane-updater" {
			continue
		}
		services = append(services, service)
	}
	return services, nil
}

func (s *server) restoreFiles(backupDir, composeFile string) error {
	s.logf("attempting file/image rollback; database schema is not rolled back")
	if err := copyFile(filepath.Join(backupDir, ".env"), filepath.Join(s.deployDir, ".env")); err != nil {
		return err
	}
	for _, file := range []string{"compose.production.yml", "compose.postgres.yml"} {
		backupPath := filepath.Join(backupDir, file)
		if _, err := os.Stat(backupPath); err == nil {
			if err := copyFile(backupPath, filepath.Join(s.deployDir, file)); err != nil {
				return err
			}
		}
	}

	services, err := s.composeServices(composeFile)
	if err != nil {
		return err
	}
	if len(services) == 0 {
		return nil
	}
	args := append([]string{"compose", "-f", composeFile, "up", "-d", "--remove-orphans"}, services...)
	return s.run("docker", args, nil)
}

func (s *server) pollHealth() error {
	client := &http.Client{Timeout: 10 * time.Second}
	for attempt := 1; attempt <= 30; attempt++ {
		response, err := client.Get(s.healthURL)
		if err == nil {
			response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				return nil
			}
			s.logf("health check attempt %d returned %d", attempt, response.StatusCode)
		} else {
			s.logf("health check attempt %d failed: %v", attempt, err)
		}
		time.Sleep(5 * time.Second)
	}
	return errors.New("control plane did not become healthy after upgrade")
}

func (s *server) run(name string, args []string, displayArgs []string) error {
	if displayArgs == nil {
		displayArgs = args
	}
	s.logf("$ %s %s", name, strings.Join(displayArgs, " "))

	cmd := exec.Command(name, args...)
	cmd.Dir = s.deployDir

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return err
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go s.pipeLogs(&wg, stdout)
	go s.pipeLogs(&wg, stderr)
	wg.Wait()

	if err := cmd.Wait(); err != nil {
		return err
	}
	return nil
}

func (s *server) pipeLogs(wg *sync.WaitGroup, reader io.Reader) {
	defer wg.Done()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r\n")
		if line != "" {
			s.logf("%s", line)
		}
	}
	if err := scanner.Err(); err != nil {
		s.logf("failed to read process output: %v", err)
	}
}

func (s *server) runOutput(name string, args []string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = s.deployDir
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if stderr.Len() > 0 {
			return "", errors.New(strings.TrimSpace(stderr.String()))
		}
		return "", err
	}
	return stdout.String(), nil
}
