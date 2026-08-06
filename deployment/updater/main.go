package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
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

type releaseManifest struct {
	Version      string            `json:"version"`
	Commit       string            `json:"commit"`
	Binaries     map[string]string `json:"binaries"`
	ComposeFiles map[string]string `json:"composeFiles"`
	Images       map[string]string `json:"images"`
}

type server struct {
	deployDir      string
	token          string
	rawBaseURL     string
	releaseBaseURL string
	healthURL      string
	httpClient     *http.Client

	mu     sync.Mutex
	status updaterStatus
}

var (
	versionPattern = regexp.MustCompile(`^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)
	commitPattern  = regexp.MustCompile(`^[0-9a-f]{40}$`)
	sha256Pattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	digestPattern  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

var composeManifestPaths = []string{
	"deployment/compose.production.yml",
	"deployment/compose.postgres.yml",
}

var imageNames = []string{"web", "registry", "updater"}

const maxReleaseManifestSize = 1024 * 1024

func main() {
	s := &server{
		deployDir:      getenv("DEPLOY_DIR", "/opt/techulus-cloud"),
		token:          os.Getenv("CONTROL_PLANE_UPDATER_TOKEN"),
		rawBaseURL:     getenv("RAW_BASE_URL", "https://raw.githubusercontent.com/techulus/cloud"),
		releaseBaseURL: getenv("RELEASE_BASE_URL", "https://github.com/techulus/cloud/releases/download"),
		healthURL:      getenv("WEB_HEALTH_URL", "http://web:3000/api/health"),
		httpClient:     &http.Client{Timeout: 2 * time.Minute},
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
	data, err := os.ReadFile(filepath.Join(s.deployDir, "updater-status.json"))
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
	if err := os.WriteFile(filepath.Join(s.deployDir, "updater-status.json"), data, 0o600); err != nil {
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

type envSetting struct {
	key   string
	value string
}

func updateEnv(envPath, text string, settings []envSetting) error {
	lines := strings.Split(strings.TrimRight(text, "\r\n"), "\n")
	found := make(map[string]bool, len(settings))
	for i, line := range lines {
		for _, setting := range settings {
			if strings.HasPrefix(line, setting.key+"=") {
				lines[i] = setting.key + "=" + setting.value
				found[setting.key] = true
				break
			}
		}
	}
	for _, setting := range settings {
		if !found[setting.key] {
			lines = append(lines, setting.key+"="+setting.value)
		}
	}
	return writeFileAtomically(envPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
}

func manifestEnvSettings(targetVersion string, manifest *releaseManifest) []envSetting {
	return []envSetting{
		{key: "TECHULUS_CLOUD_VERSION", value: targetVersion},
		{key: "TECHULUS_CLOUD_WEB_IMAGE", value: imageReference("web", manifest.Images["web"])},
		{key: "TECHULUS_CLOUD_REGISTRY_IMAGE", value: imageReference("registry", manifest.Images["registry"])},
		{key: "TECHULUS_CLOUD_UPDATER_IMAGE", value: imageReference("updater", manifest.Images["updater"])},
	}
}

func imageReference(name, digest string) string {
	return fmt.Sprintf("ghcr.io/techulus/cloud/%s@%s", name, digest)
}

func validateReleaseManifest(manifest *releaseManifest, targetVersion string) error {
	if manifest.Version != targetVersion {
		return fmt.Errorf("release manifest version %q does not match target %q", manifest.Version, targetVersion)
	}
	if !commitPattern.MatchString(manifest.Commit) {
		return errors.New("release manifest contains an invalid commit")
	}
	for _, name := range []string{"agent-linux-amd64", "agent-linux-arm64"} {
		if !sha256Pattern.MatchString(manifest.Binaries[name]) {
			return fmt.Errorf("release manifest contains an invalid checksum for %s", name)
		}
	}
	for _, path := range composeManifestPaths {
		if !sha256Pattern.MatchString(manifest.ComposeFiles[path]) {
			return fmt.Errorf("release manifest contains an invalid checksum for %s", path)
		}
	}
	for _, name := range imageNames {
		if !digestPattern.MatchString(manifest.Images[name]) {
			return fmt.Errorf("release manifest contains an invalid digest for %s", name)
		}
	}
	return nil
}

func (s *server) client() *http.Client {
	if s.httpClient != nil {
		return s.httpClient
	}
	return &http.Client{Timeout: 2 * time.Minute}
}

func (s *server) fetchReleaseManifest(targetVersion string) (*releaseManifest, error) {
	url := fmt.Sprintf("%s/%s/release-manifest.json", strings.TrimRight(s.releaseBaseURL, "/"), targetVersion)
	response, err := s.client().Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to download release manifest: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release manifest download failed with status %d", response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxReleaseManifestSize+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read release manifest: %w", err)
	}
	if len(body) > maxReleaseManifestSize {
		return nil, errors.New("release manifest exceeds maximum size")
	}

	var manifest releaseManifest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return nil, fmt.Errorf("failed to parse release manifest: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("release manifest contains trailing data")
	}
	if err := validateReleaseManifest(&manifest, targetVersion); err != nil {
		return nil, err
	}
	return &manifest, nil
}

func (s *server) downloadFile(url, destination string) error {
	response, err := s.client().Get(url)
	if err != nil {
		return fmt.Errorf("failed to download %s: %w", filepath.Base(destination), err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download of %s failed with status %d", filepath.Base(destination), response.StatusCode)
	}

	file, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(file, response.Body); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func verifyFileSHA256(path, expected string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return fmt.Errorf("checksum verification failed for %s", filepath.Base(path))
	}
	return nil
}

func (s *server) stageComposeFiles(manifest *releaseManifest, stagingDir string) error {
	for _, manifestPath := range composeManifestPaths {
		name := filepath.Base(manifestPath)
		destination := filepath.Join(stagingDir, name)
		url := fmt.Sprintf("%s/%s/%s", strings.TrimRight(s.rawBaseURL, "/"), manifest.Commit, manifestPath)
		if err := s.downloadFile(url, destination); err != nil {
			return err
		}
		if err := verifyFileSHA256(destination, manifest.ComposeFiles[manifestPath]); err != nil {
			return err
		}
	}
	return nil
}

func supportedComposeFile(name string) bool {
	return name == "compose.production.yml" || name == "compose.postgres.yml"
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
	manifest, err := s.fetchReleaseManifest(targetVersion)
	if err != nil {
		return err
	}

	stagingDir, err := os.MkdirTemp(s.deployDir, ".update-staging-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stagingDir)

	s.logf("downloading and verifying compose files for %s at %s", targetVersion, manifest.Commit)
	if err := s.stageComposeFiles(manifest, stagingDir); err != nil {
		return err
	}

	envPath := filepath.Join(s.deployDir, ".env")
	env, envText, err := parseEnv(envPath)
	if err != nil {
		return fmt.Errorf("%s not found: %w", envPath, err)
	}

	if value := env["COMPOSE_FILE"]; value != "" {
		*composeFile = value
	}
	if !supportedComposeFile(*composeFile) {
		return fmt.Errorf("unsupported COMPOSE_FILE %q", *composeFile)
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

	for _, manifestPath := range composeManifestPaths {
		name := filepath.Base(manifestPath)
		if err := os.Rename(filepath.Join(stagingDir, name), filepath.Join(s.deployDir, name)); err != nil {
			return err
		}
	}
	if err := updateEnv(envPath, envText, manifestEnvSettings(targetVersion, manifest)); err != nil {
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

	output, err := os.CreateTemp(filepath.Dir(destination), "."+filepath.Base(destination)+".tmp-")
	if err != nil {
		return err
	}
	temporaryPath := output.Name()
	defer os.Remove(temporaryPath)

	if err := output.Chmod(0o600); err != nil {
		output.Close()
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, destination)
}

func writeFileAtomically(path string, data []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-")
	if err != nil {
		return err
	}
	temporaryPath := file.Name()
	defer os.Remove(temporaryPath)

	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
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

	return cmd.Wait()
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
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.Output()
	if err != nil {
		if stderr.Len() > 0 {
			return "", errors.New(strings.TrimSpace(stderr.String()))
		}
		return "", err
	}
	return string(stdout), nil
}
