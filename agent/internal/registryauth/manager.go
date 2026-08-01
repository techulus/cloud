package registryauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"techulus/cloud-agent/internal/crypto"
)

var dnsLabelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)

type Registry struct {
	ID                string `json:"id"`
	Host              string `json:"host"`
	AuthKey           string `json:"authKey"`
	Username          string `json:"username"`
	EncryptedPassword string `json:"encryptedPassword"`
	TLSVerify         bool   `json:"tlsVerify"`
	System            bool   `json:"system"`
}
type Bundle struct {
	Version    string     `json:"version"`
	Registries []Registry `json:"registries"`
}
type BundleSource interface {
	GetRegistryBundle(context.Context) (*Bundle, error)
}

type generationState struct {
	Version string          `json:"version"`
	TLS     map[string]bool `json:"tls"`
}

type Snapshot struct {
	GenerationDir, AuthFile, DockerConfigDir, EmptyHome string
	tls                                                 map[string]bool
	Ready                                               bool
}

func (s Snapshot) TLSVerify(ref string) bool {
	h, err := ImageHost(ref)
	if err != nil {
		return true
	}
	v, ok := s.tls[h]
	return !ok || v
}

type Manager struct {
	mu           sync.Mutex
	root, key    string
	source       BundleSource
	snapshot     Snapshot
	version      string
	generations  map[string]*generationLease
	syncRequired bool
}

type generationLease struct {
	readers int
	retired bool
}

func NewManager(dataDir, encryptionKey string, source BundleSource) (*Manager, error) {
	m := &Manager{root: filepath.Join(dataDir, "registry"), key: encryptionKey, source: source, generations: map[string]*generationLease{}}
	for _, d := range []string{m.root, filepath.Join(m.root, "generations"), filepath.Join(m.root, "empty-home")} {
		if err := os.MkdirAll(d, 0700); err != nil {
			return nil, err
		}
	}
	if _, err := os.Stat(filepath.Join(m.root, "sync-required")); err == nil {
		m.syncRequired = true
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("inspect registry synchronization marker: %w", err)
	}
	current, _ := filepath.EvalSymlinks(filepath.Join(m.root, "current"))
	generationsDir := filepath.Join(m.root, "generations")
	if current != "" && strings.HasPrefix(current, generationsDir+string(os.PathSeparator)) {
		var state generationState
		stateData, stateErr := os.ReadFile(filepath.Join(current, "state.json"))
		configInfo, configErr := os.Stat(filepath.Join(current, "config.json"))
		if stateErr == nil && configErr == nil && !configInfo.IsDir() && json.Unmarshal(stateData, &state) == nil && state.Version != "" {
			m.version = state.Version
			m.snapshot = Snapshot{
				GenerationDir:   current,
				AuthFile:        filepath.Join(current, "config.json"),
				DockerConfigDir: current,
				EmptyHome:       filepath.Join(m.root, "empty-home"),
				tls:             state.TLS,
				Ready:           true,
			}
			m.generations[current] = &generationLease{}
		}
	}
	entries, err := os.ReadDir(generationsDir)
	if err != nil {
		return nil, fmt.Errorf("read registry generations: %w", err)
	}
	for _, e := range entries {
		p := filepath.Join(generationsDir, e.Name())
		if e.IsDir() && p != current {
			if err := os.RemoveAll(p); err != nil {
				return nil, fmt.Errorf("remove stale registry generation: %w", err)
			}
		}
	}
	return m, nil
}
func (m *Manager) MarkDirty(version string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.markDirtyLocked(version)
}
func (m *Manager) markDirtyLocked(version string) error {
	if version == "" {
		return errors.New("registry sync version is required")
	}
	m.syncRequired = true
	if err := writeSyncedFile(filepath.Join(m.root, "sync-required"), []byte(version), 0600); err != nil {
		return err
	}
	return syncDir(m.root)
}
func (m *Manager) Acquire() (Snapshot, func(), error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.snapshot
	s.Ready = s.Ready && !m.syncRequired
	if !s.Ready {
		return s, nil, errors.New("registry authentication unavailable or synchronization required")
	}
	lease := m.generations[s.GenerationDir]
	if lease == nil || lease.retired {
		return s, nil, errors.New("registry authentication generation unavailable")
	}
	lease.readers++
	var once sync.Once
	release := func() {
		once.Do(func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			if current := m.generations[s.GenerationDir]; current != nil && current.readers > 0 {
				current.readers--
			}
			if err := m.cleanupRetiredLocked(); err != nil {
				log.Printf("[registry] failed to remove retired authentication generation: %v", err)
			}
		})
	}
	return s, release, nil
}
func (m *Manager) Sync(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sync(ctx)
}
func (m *Manager) sync(ctx context.Context) error {
	b, err := m.source.GetRegistryBundle(ctx)
	if err != nil {
		return fmt.Errorf("fetch registry bundle: %w", err)
	}
	if b == nil || b.Version == "" {
		return errors.New("invalid registry bundle")
	}
	if b.Version == m.version && m.snapshot.GenerationDir != "" && m.snapshot.Ready {
		if err := m.cleanupRetiredLocked(); err != nil {
			return err
		}
		if err := removeIfPresent(filepath.Join(m.root, "sync-required")); err != nil {
			return err
		}
		if err := syncDir(m.root); err != nil {
			return err
		}
		m.syncRequired = false
		m.snapshot.Ready = true
		return nil
	}
	if err := m.markDirtyLocked(b.Version); err != nil {
		return fmt.Errorf("persist required registry synchronization: %w", err)
	}
	auths := map[string]map[string]string{}
	tls := map[string]bool{}
	for _, r := range b.Registries {
		h, err := CanonicalHost(r.Host)
		if err != nil || h != r.Host || r.ID == "" || r.AuthKey == "" || r.Username == "" || r.EncryptedPassword == "" {
			return errors.New("invalid registry bundle entry")
		}
		if _, ok := tls[h]; ok {
			return errors.New("duplicate registry host")
		}
		if r.AuthKey != RegistryAuthKey(h) {
			return errors.New("invalid registry authentication key")
		}
		if _, ok := auths[r.AuthKey]; ok {
			return errors.New("duplicate registry authentication key")
		}
		p, err := crypto.DecryptRegistryCredential(r.EncryptedPassword, m.key, r.ID, h)
		if err != nil {
			return errors.New("invalid encrypted registry credential")
		}
		auths[r.AuthKey] = map[string]string{"auth": base64.StdEncoding.EncodeToString([]byte(r.Username + ":" + p))}
		tls[h] = r.TLSVerify
	}
	generation, err := generationID()
	if err != nil {
		return fmt.Errorf("generate registry state id: %w", err)
	}
	dir := filepath.Join(m.root, "generations", generation)
	if err := os.Mkdir(dir, 0700); err != nil {
		return err
	}
	linked := false
	defer func() {
		if !linked {
			_ = os.RemoveAll(dir)
		}
	}()
	data, err := json.Marshal(struct {
		Auths map[string]map[string]string `json:"auths"`
	}{auths})
	if err != nil {
		return err
	}
	if err = writeSyncedFile(filepath.Join(dir, "config.json"), data, 0600); err != nil {
		return err
	}
	stateData, err := json.Marshal(generationState{Version: b.Version, TLS: tls})
	if err != nil {
		return err
	}
	if err = writeSyncedFile(filepath.Join(dir, "state.json"), stateData, 0600); err != nil {
		return err
	}
	if err = syncDir(dir); err != nil {
		return err
	}
	tmpID, err := generationID()
	if err != nil {
		return fmt.Errorf("generate registry symlink id: %w", err)
	}
	tmp := filepath.Join(m.root, "current.tmp-"+tmpID)
	if err = os.Symlink(filepath.Join("generations", filepath.Base(dir)), tmp); err != nil {
		return err
	}
	defer os.Remove(tmp)
	if err = os.Rename(tmp, filepath.Join(m.root, "current")); err != nil {
		return err
	}
	linked = true
	previousGeneration := m.snapshot.GenerationDir
	m.version = b.Version
	m.snapshot = Snapshot{GenerationDir: dir, AuthFile: filepath.Join(dir, "config.json"), DockerConfigDir: dir, EmptyHome: filepath.Join(m.root, "empty-home"), tls: tls, Ready: true}
	m.generations[dir] = &generationLease{}
	if previousGeneration != "" && previousGeneration != dir {
		if previous := m.generations[previousGeneration]; previous != nil {
			previous.retired = true
		}
	}
	if err = syncDir(m.root); err != nil {
		return err
	}
	if err = m.cleanupRetiredLocked(); err != nil {
		return err
	}
	if err = removeIfPresent(filepath.Join(m.root, "sync-required")); err != nil {
		return err
	}
	if err = syncDir(m.root); err != nil {
		return err
	}
	m.syncRequired = false
	return nil
}

func (m *Manager) cleanupRetiredLocked() error {
	for dir, generation := range m.generations {
		if !generation.retired || generation.readers != 0 {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return fmt.Errorf("remove retired registry generation: %w", err)
		}
		delete(m.generations, dir)
	}
	return nil
}

func CanonicalHost(raw string) (string, error) {
	if raw == "" || raw != strings.TrimSpace(raw) || strings.Contains(raw, "://") || strings.ContainsAny(raw, "/?#@") {
		return "", errors.New("invalid registry host")
	}
	s := strings.ToLower(raw)
	if s == "index.docker.io" || s == "registry-1.docker.io" {
		s = "docker.io"
	}
	var hostname string
	if strings.HasPrefix(s, "[") {
		end := strings.IndexByte(s, ']')
		if end < 0 || net.ParseIP(s[1:end]) == nil || (len(s) > end+1 && (s[end+1] != ':' || !validPort(s[end+2:]))) {
			return "", errors.New("invalid registry host")
		}
		hostname = s[1:end]
	} else if host, port, ok := strings.Cut(s, ":"); ok {
		if host == "" || !validPort(port) || strings.Contains(host, ":") {
			return "", errors.New("invalid registry host")
		}
		hostname = host
	} else {
		hostname = s
	}
	if strings.ContainsAny(s, " \\") {
		return "", errors.New("invalid registry host")
	}
	if net.ParseIP(hostname) == nil {
		if len(hostname) > 253 {
			return "", errors.New("invalid registry host")
		}
		for _, label := range strings.Split(hostname, ".") {
			if len(label) > 63 || !dnsLabelPattern.MatchString(label) {
				return "", errors.New("invalid registry host")
			}
		}
	}
	return s, nil
}
func validPort(s string) bool {
	p, err := strconv.Atoi(s)
	return err == nil && p > 0 && p <= 65535 && strconv.Itoa(p) == s
}
func RegistryAuthKey(host string) string {
	if host == "docker.io" {
		return "https://index.docker.io/v1/"
	}
	return host
}
func ImageHost(ref string) (string, error) {
	s := strings.TrimSpace(ref)
	if s == "" {
		return "", errors.New("empty image")
	}
	first := strings.SplitN(s, "/", 2)[0]
	if !strings.Contains(s, "/") || (!strings.Contains(first, ".") && !strings.Contains(first, ":") && first != "localhost" && !strings.HasPrefix(first, "[")) {
		return "docker.io", nil
	}
	return CanonicalHost(first)
}
func NormalizeImage(ref string) string {
	h, e := ImageHost(ref)
	if e != nil {
		return ref
	}
	s := ref
	first := strings.SplitN(s, "/", 2)
	if h == "docker.io" {
		if len(first) == 1 {
			s = "library/" + s
		} else if first[0] == "docker.io" || first[0] == "index.docker.io" || first[0] == "registry-1.docker.io" {
			s = first[1]
		}
		if !strings.Contains(s, "/") {
			s = "library/" + s
		}
		s = "docker.io/" + s
	}
	at := strings.Index(s, "@")
	name := s
	if at >= 0 {
		name = s[:at]
	}
	slash := strings.LastIndex(name, "/")
	if at < 0 && strings.LastIndex(name, ":") <= slash {
		s += ":latest"
	}
	return s
}

func generationID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func writeSyncedFile(path string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	err = dir.Sync()
	closeErr := dir.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func removeIfPresent(path string) error {
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
