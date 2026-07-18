package build

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"techulus/cloud-agent/internal/container"
	"techulus/cloud-agent/internal/paths"
)

type Config struct {
	BuildID           string
	CloneURL          string
	CommitSha         string
	Branch            string
	ImageRepository   string
	ImageURI          string
	ResolvedCommitSha string
	ServiceID         string
	ProjectID         string
	RootDir           string
	Secrets           map[string]string
	TargetPlatforms   []string
}

type LogSender interface {
	SendBuildLogs(buildID, serviceID, projectID string, logs []string) error
}

type Builder struct {
	dataDir   string
	logSender LogSender
}

const (
	staleBuildDirAge     = 1 * time.Hour
	staleTempArtifactAge = 24 * time.Hour
)

var managedTempArtifactPattern = regexp.MustCompile(`^(backup|restore)-[0-9a-fA-F-]{36}\.tar\.gz$|^restore-extract-[0-9a-fA-F-]{36}$`)

func NewBuilder(dataDir string, logSender LogSender) *Builder {
	return &Builder{
		dataDir:   dataDir,
		logSender: logSender,
	}
}

func (b *Builder) Build(ctx context.Context, config *Config, checkCancelled func() bool, onStatusChange func(status string)) error {
	buildDir := filepath.Join(b.dataDir, "builds", config.BuildID)

	if err := os.MkdirAll(buildDir, 0755); err != nil {
		return fmt.Errorf("failed to create build directory: %w", err)
	}

	defer func() {
		log.Printf("[build:%s] cleaning up build directory", truncateStr(config.BuildID, 8))
		os.RemoveAll(buildDir)
	}()

	if checkCancelled() {
		return fmt.Errorf("build cancelled")
	}

	if err := b.clone(ctx, config, buildDir); err != nil {
		return fmt.Errorf("clone failed: %w", err)
	}

	if config.CommitSha == "HEAD" && config.ImageRepository != "" && config.ResolvedCommitSha != "" {
		config.ImageURI = fmt.Sprintf("%s:%s", config.ImageRepository, config.ResolvedCommitSha)
		b.sendLog(config, fmt.Sprintf("Resolved image tag %s", config.ImageURI))
	}

	if checkCancelled() {
		return fmt.Errorf("build cancelled")
	}

	if onStatusChange != nil {
		onStatusChange("building")
	}

	if err := b.buildAndPush(ctx, config, buildDir); err != nil {
		return fmt.Errorf("build failed: %w", err)
	}

	return nil
}

func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

func tailLines(output string, n int) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) <= n {
		return strings.TrimSpace(output)
	}
	return strings.Join(lines[len(lines)-n:], "\n")
}

func computeSecretsHash(secrets map[string]string) string {
	if len(secrets) == 0 {
		return ""
	}

	keys := make([]string, 0, len(secrets))
	for k := range secrets {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var sb strings.Builder
	for _, k := range keys {
		sb.WriteString(k)
		sb.WriteString("=")
		sb.WriteString(secrets[k])
		sb.WriteString("\n")
	}

	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}

func (b *Builder) clone(ctx context.Context, config *Config, buildDir string) error {
	log.Printf("[build:%s] cloning repository", truncateStr(config.BuildID, 8))

	safeURL := config.CloneURL
	if idx := strings.Index(safeURL, "@"); idx != -1 {
		safeURL = "https://***@" + safeURL[idx+1:]
	}
	b.sendLog(config, fmt.Sprintf("Cloning %s", safeURL))

	branch := config.Branch
	if branch == "" {
		branch = "main"
	}

	if config.CommitSha == "HEAD" {
		cmd := exec.CommandContext(ctx, "git", "clone", "--depth", "1", "--branch", branch, config.CloneURL, buildDir)
		output, err := b.runCommand(cmd, config)
		if err != nil {
			return fmt.Errorf("git clone failed: %s: %w", output, err)
		}
		b.sendLog(config, fmt.Sprintf("Cloned branch %s", branch))
	} else {
		if matched, _ := regexp.MatchString(`^[0-9a-fA-F]{40}$`, config.CommitSha); !matched {
			return fmt.Errorf("invalid exact commit SHA")
		}
		cmd := exec.CommandContext(ctx, "git", "clone", "--depth", "50", "--branch", branch, "--single-branch", config.CloneURL, buildDir)
		output, err := b.runCommand(cmd, config)
		if err != nil {
			return fmt.Errorf("git clone failed: %s: %w", output, err)
		}

		b.sendLog(config, fmt.Sprintf("Checking out commit %s", truncateStr(config.CommitSha, 8)))

		cmd = exec.CommandContext(ctx, "git", "-C", buildDir, "cat-file", "-e", config.CommitSha+"^{commit}")
		_, err = b.runCommand(cmd, config)
		if err != nil {
			b.sendLog(config, "Selected commit is outside the shallow clone; fetching full branch history")
			cmd = exec.CommandContext(ctx, "git", "-C", buildDir, "fetch", "--unshallow", "origin", branch)
			output, err = b.runCommand(cmd, config)
			if err != nil {
				return fmt.Errorf("git fetch full branch history failed: %s: %w", output, err)
			}
		}

		cmd = exec.CommandContext(ctx, "git", "-C", buildDir, "checkout", config.CommitSha)
		output, err = b.runCommand(cmd, config)
		if err != nil {
			return fmt.Errorf("git checkout failed: %s: %w", output, err)
		}
	}

	b.sendLog(config, "Clone completed")
	resolvedCommitSha, err := b.resolveCommitSha(ctx, config, buildDir)
	if err != nil {
		return err
	}
	if config.CommitSha != "HEAD" && !strings.EqualFold(resolvedCommitSha, config.CommitSha) {
		return fmt.Errorf("checked out commit %s, expected %s", resolvedCommitSha, config.CommitSha)
	}
	config.ResolvedCommitSha = resolvedCommitSha
	b.sendLog(config, fmt.Sprintf("Resolved commit %s", truncateStr(resolvedCommitSha, 8)))
	return nil
}

func (b *Builder) resolveCommitSha(ctx context.Context, config *Config, buildDir string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", buildDir, "rev-parse", "HEAD")
	output, err := b.runCommand(cmd, config)
	if err != nil {
		return "", fmt.Errorf("failed to resolve commit sha: %s: %w", output, err)
	}

	resolvedCommitSha := strings.TrimSpace(output)
	if resolvedCommitSha == "" {
		return "", fmt.Errorf("resolved commit sha is empty")
	}

	return resolvedCommitSha, nil
}

func (b *Builder) buildAndPush(ctx context.Context, config *Config, buildDir string) error {
	contextDir := buildDir
	if config.RootDir != "" {
		contextDir = filepath.Join(buildDir, config.RootDir)
		if _, err := os.Stat(contextDir); err != nil {
			return fmt.Errorf("root directory %s does not exist: %w", config.RootDir, err)
		}
		b.sendLog(config, fmt.Sprintf("Using root directory: %s", config.RootDir))
	}

	dockerfileRelPath := "Dockerfile"
	hasDockerfile := false
	forcedDockerfile := false
	if customPath := config.Secrets["TECHULUS_DOCKERFILE_PATH"]; customPath != "" {
		if !filepath.IsLocal(customPath) {
			return fmt.Errorf("TECHULUS_DOCKERFILE_PATH must be a relative path within the build context, got %q", customPath)
		}
		resolved := filepath.Join(contextDir, customPath)
		if info, err := os.Stat(resolved); err != nil || info.IsDir() {
			b.sendLog(config, fmt.Sprintf("TECHULUS_DOCKERFILE_PATH is set but %s was not found in the repository", customPath))
			return fmt.Errorf("TECHULUS_DOCKERFILE_PATH %q not found in build context", customPath)
		}
		dockerfileRelPath = filepath.Clean(customPath)
		hasDockerfile = true
		forcedDockerfile = true
	} else if _, err := os.Stat(filepath.Join(contextDir, "Dockerfile")); err == nil {
		hasDockerfile = true
	}

	buildkitAddr := os.Getenv("BUILDKIT_HOST")
	if buildkitAddr == "" {
		buildkitAddr = paths.BuildKitSocket
	}

	var secretArgs []string
	var secretEnv []string
	for key, value := range config.Secrets {
		secretArgs = append(secretArgs, "--secret", fmt.Sprintf("id=%s,env=%s", key, key))
		secretEnv = append(secretEnv, fmt.Sprintf("%s=%s", key, value))
	}

	platform := "linux/amd64"
	if len(config.TargetPlatforms) > 0 {
		platform = config.TargetPlatforms[0]
	}
	arch := strings.Split(platform, "/")[1]

	archImageUri := config.ImageURI + "-" + arch
	archOutputFlag := fmt.Sprintf("type=image,name=%s,push=true,registry.insecure=true", archImageUri)

	if hasDockerfile {
		log.Printf("[build:%s] building with Dockerfile %s via buildctl for %s", truncateStr(config.BuildID, 8), dockerfileRelPath, platform)
		if forcedDockerfile {
			b.sendLog(config, fmt.Sprintf("Using Dockerfile %s (from TECHULUS_DOCKERFILE_PATH)", dockerfileRelPath))
		} else {
			b.sendLog(config, "Using existing Dockerfile")
		}
		b.sendLog(config, fmt.Sprintf("Building and pushing %s", archImageUri))

		args := []string{
			"--addr", buildkitAddr,
			"build",
			"--frontend", "dockerfile.v0",
			"--local", "context=.",
			"--local", fmt.Sprintf("dockerfile=%s", filepath.Dir(dockerfileRelPath)),
			"--opt", fmt.Sprintf("filename=%s", filepath.Base(dockerfileRelPath)),
			"--opt", fmt.Sprintf("platform=%s", platform),
			"--output", archOutputFlag,
		}
		args = append(args, secretArgs...)

		cmd := exec.CommandContext(ctx, paths.BuildctlPath, args...)
		cmd.Dir = contextDir
		cmd.Env = append(os.Environ(), secretEnv...)
		output, err := b.runCommandStreaming(cmd, config)
		if err != nil {
			log.Printf("[build:%s] buildctl failed with output: %s", truncateStr(config.BuildID, 8), output)
			b.sendLog(config, fmt.Sprintf("Build error: %s", output))
			return fmt.Errorf("buildctl build failed:\n%s", tailLines(output, 20))
		}
	} else {
		log.Printf("[build:%s] building with Railpack via buildctl for %s", truncateStr(config.BuildID, 8), platform)
		b.sendLog(config, "No Dockerfile found, using Railpack...")

		b.sendLog(config, "Generating build plan...")
		prepareArgs := []string{"prepare", ".", "--plan-out", "railpack-plan.json"}
		for key, value := range config.Secrets {
			prepareArgs = append(prepareArgs, "--env", fmt.Sprintf("%s=%s", key, value))
		}

		cmd := exec.CommandContext(ctx, paths.RailpackPath, prepareArgs...)
		cmd.Dir = contextDir
		output, err := b.runCommandStreaming(cmd, config)
		if err != nil {
			log.Printf("[build:%s] railpack prepare failed with output: %s", truncateStr(config.BuildID, 8), output)
			b.sendLog(config, fmt.Sprintf("Railpack prepare error: %s", output))
			return fmt.Errorf("railpack prepare failed:\n%s", tailLines(output, 20))
		}

		b.sendLog(config, fmt.Sprintf("Building for %s...", platform))

		args := []string{
			"--addr", buildkitAddr,
			"build",
			"--frontend", "gateway.v0",
			"--opt", "source=ghcr.io/railwayapp/railpack-frontend:v0.15.4",
			"--local", "context=.",
			"--local", "dockerfile=.",
			"--opt", "filename=railpack-plan.json",
			"--opt", fmt.Sprintf("platform=%s", platform),
			"--output", archOutputFlag,
		}

		secretsHash := computeSecretsHash(config.Secrets)
		if secretsHash != "" {
			args = append(args, "--opt", fmt.Sprintf("build-arg:secrets-hash=%s", secretsHash))
		}
		args = append(args, secretArgs...)

		cmd = exec.CommandContext(ctx, paths.BuildctlPath, args...)
		cmd.Dir = contextDir
		cmd.Env = append(os.Environ(), secretEnv...)
		output, err = b.runCommandStreaming(cmd, config)
		if err != nil {
			log.Printf("[build:%s] buildctl failed for %s: %s", truncateStr(config.BuildID, 8), platform, output)
			b.sendLog(config, fmt.Sprintf("Build error (%s): %s", platform, output))
			return fmt.Errorf("buildctl build failed for %s:\n%s", platform, tailLines(output, 20))
		}
	}

	b.sendLog(config, "Build completed")
	return nil
}

func (b *Builder) runCommand(cmd *exec.Cmd, config *Config) (string, error) {
	output, err := cmd.CombinedOutput()
	outputStr := string(output)

	if len(outputStr) > 0 {
		lines := strings.Split(strings.TrimSpace(outputStr), "\n")
		for _, line := range lines {
			if strings.TrimSpace(line) != "" {
				b.sendLog(config, line)
			}
		}
	}

	return outputStr, err
}

func (b *Builder) runCommandStreaming(cmd *exec.Cmd, config *Config) (string, error) {
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}

	if err := cmd.Start(); err != nil {
		return "", err
	}

	var mu sync.Mutex
	var outputLines []string
	logBuffer := make([]string, 0, 50)
	lastFlush := time.Now()

	flushLogs := func() {
		if len(logBuffer) > 0 && b.logSender != nil {
			if err := b.logSender.SendBuildLogs(config.BuildID, config.ServiceID, config.ProjectID, logBuffer); err != nil {
				log.Printf("[build:%s] failed to send %d log lines: %v", truncateStr(config.BuildID, 8), len(logBuffer), err)
			}
			logBuffer = logBuffer[:0]
			lastFlush = time.Now()
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			mu.Lock()
			outputLines = append(outputLines, line)
			logBuffer = append(logBuffer, line)
			if len(logBuffer) >= 50 || time.Since(lastFlush) > 2*time.Second {
				flushLogs()
			}
			mu.Unlock()
		}
	}()

	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			mu.Lock()
			outputLines = append(outputLines, line)
			logBuffer = append(logBuffer, line)
			if len(logBuffer) >= 50 || time.Since(lastFlush) > 2*time.Second {
				flushLogs()
			}
			mu.Unlock()
		}
	}()

	wg.Wait()
	err = cmd.Wait()

	mu.Lock()
	flushLogs()
	mu.Unlock()

	return strings.Join(outputLines, "\n"), err
}

func (b *Builder) sendLog(config *Config, message string) {
	log.Printf("[build:%s] %s", truncateStr(config.BuildID, 8), message)
	if b.logSender != nil {
		b.logSender.SendBuildLogs(config.BuildID, config.ServiceID, config.ProjectID, []string{message})
	}
}

func (b *Builder) Cleanup() error {
	now := time.Now()
	var cleanupErrors []error

	if err := cleanupStaleBuildDirs(filepath.Join(b.dataDir, "builds"), now.Add(-staleBuildDirAge)); err != nil {
		cleanupErrors = append(cleanupErrors, err)
	}

	if err := cleanupManagedTempArtifacts(filepath.Join(b.dataDir, "tmp"), now.Add(-staleTempArtifactAge)); err != nil {
		cleanupErrors = append(cleanupErrors, err)
	}

	log.Printf("[build:cleanup] pruning unused images")
	if err := container.ImagePrune(); err != nil {
		cleanupErrors = append(cleanupErrors, err)
	}

	return errors.Join(cleanupErrors...)
}

func cleanupStaleBuildDirs(buildsDir string, cutoff time.Time) error {
	entries, err := os.ReadDir(buildsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var cleanupErrors []error
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		if info.ModTime().Before(cutoff) {
			path := filepath.Join(buildsDir, entry.Name())
			log.Printf("[build:cleanup] removing stale build dir: %s", entry.Name())
			if err := os.RemoveAll(path); err != nil {
				cleanupErrors = append(cleanupErrors, err)
			}
		}
	}

	return errors.Join(cleanupErrors...)
}

func cleanupManagedTempArtifacts(tmpDir string, cutoff time.Time) error {
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var cleanupErrors []error
	for _, entry := range entries {
		if !managedTempArtifactPattern.MatchString(entry.Name()) {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		if info.ModTime().After(cutoff) {
			continue
		}

		path := filepath.Join(tmpDir, entry.Name())
		log.Printf("[build:cleanup] removing stale temp artifact: %s", entry.Name())
		if err := os.RemoveAll(path); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}

	return errors.Join(cleanupErrors...)
}

func CheckPrerequisites() error {
	if _, err := exec.LookPath("git"); err != nil {
		return fmt.Errorf("git not found: %w", err)
	}
	if _, err := os.Stat(paths.BuildctlPath); err != nil {
		return fmt.Errorf("buildctl not found at %s: %w", paths.BuildctlPath, err)
	}
	if _, err := os.Stat(paths.RailpackPath); err != nil {
		return fmt.Errorf("railpack not found at %s: %w", paths.RailpackPath, err)
	}
	if _, err := os.Stat(paths.CranePath); err != nil {
		return fmt.Errorf("crane not found at %s: %w", paths.CranePath, err)
	}
	return nil
}
