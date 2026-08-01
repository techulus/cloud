package registryauth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type fakeSource struct {
	bundle *Bundle
	err    error
}

func (f *fakeSource) GetRegistryBundle(context.Context) (*Bundle, error) { return f.bundle, f.err }

func encrypt(t *testing.T, key []byte, id, host, password string) string {
	t.Helper()
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	iv := make([]byte, gcm.NonceSize())
	sealed := gcm.Seal(nil, iv, []byte(password), []byte("registry-credential:v1\x00"+id+"\x00"+host))
	framed := append(append([]byte{}, iv...), sealed[len(sealed)-gcm.Overhead():]...)
	framed = append(framed, sealed[:len(sealed)-gcm.Overhead()]...)
	return base64.StdEncoding.EncodeToString(framed)
}

func TestReferenceVectors(t *testing.T) {
	tests := map[string]string{"alpine": "docker.io", "library/alpine": "docker.io", "index.docker.io/library/alpine": "docker.io", "registry-1.docker.io/x/y": "docker.io", "localhost:5000/x": "localhost:5000", "[::1]:5000/x": "[::1]:5000", "ghcr.io/x/y": "ghcr.io"}
	for ref, want := range tests {
		got, err := ImageHost(ref)
		if err != nil || got != want {
			t.Errorf("ImageHost(%q)=%q,%v want %q", ref, got, err, want)
		}
	}
}

func TestManagerInstallDirtyAndPermissions(t *testing.T) {
	key := make([]byte, 32)
	source := &fakeSource{}
	dir := t.TempDir()
	m, err := NewManager(dir, hex.EncodeToString(key), source)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.MarkDirty("v1"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.Acquire(); err == nil {
		t.Fatal("dirty manager was ready")
	}
	source.bundle = &Bundle{Version: "v1", Registries: []Registry{{ID: "id", Host: "docker.io", AuthKey: "https://index.docker.io/v1/", Username: "user", EncryptedPassword: encrypt(t, key, "id", "docker.io", "pass"), TLSVerify: false}}}
	if err := m.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	snapshot, release, err := m.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	release()
	var cfg struct {
		Auths map[string]struct {
			Auth string `json:"auth"`
		} `json:"auths"`
	}
	data, _ := os.ReadFile(snapshot.AuthFile)
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	if got := cfg.Auths["https://index.docker.io/v1/"].Auth; got != base64.StdEncoding.EncodeToString([]byte("user:pass")) {
		t.Fatal("wrong managed auth")
	}
	for _, p := range []string{snapshot.GenerationDir, snapshot.AuthFile, filepath.Join(snapshot.GenerationDir, "state.json")} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		want := os.FileMode(0700)
		if !info.IsDir() {
			want = 0600
		}
		if info.Mode().Perm() != want {
			t.Errorf("%s mode %o want %o", p, info.Mode().Perm(), want)
		}
	}

	restarted, err := NewManager(dir, hex.EncodeToString(key), &fakeSource{err: errors.New("offline")})
	if err != nil {
		t.Fatal(err)
	}
	restartedSnapshot, releaseRestarted, err := restarted.Acquire()
	if err != nil {
		t.Fatalf("cached generation unavailable after restart: %v", err)
	}
	defer releaseRestarted()
	if restartedSnapshot.TLSVerify("docker.io/library/alpine") {
		t.Fatal("cached TLS policy was not restored")
	}
}

func TestManagerRetainsLeasedGenerationUntilRelease(t *testing.T) {
	key := make([]byte, 32)
	source := &fakeSource{bundle: &Bundle{
		Version: "v1",
		Registries: []Registry{{
			ID:                "id",
			Host:              "registry.example.com",
			AuthKey:           "registry.example.com",
			Username:          "user",
			EncryptedPassword: encrypt(t, key, "id", "registry.example.com", "first"),
			TLSVerify:         true,
		}},
	}}
	m, err := NewManager(t.TempDir(), hex.EncodeToString(key), source)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	old, release, err := m.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	source.bundle = &Bundle{
		Version: "v2",
		Registries: []Registry{{
			ID:                "id",
			Host:              "registry.example.com",
			AuthKey:           "registry.example.com",
			Username:          "user",
			EncryptedPassword: encrypt(t, key, "id", "registry.example.com", "second"),
			TLSVerify:         true,
		}},
	}
	if err := m.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(old.GenerationDir); err != nil {
		t.Fatalf("leased generation was removed early: %v", err)
	}
	release()
	if _, err := os.Stat(old.GenerationDir); !os.IsNotExist(err) {
		t.Fatalf("retired generation was not removed after release: %v", err)
	}
}

func TestManagerFailsClosedWhenDirtyMarkerCannotBePersisted(t *testing.T) {
	key := make([]byte, 32)
	source := &fakeSource{bundle: &Bundle{Version: "v1"}}
	dataDir := t.TempDir()
	m, err := NewManager(dataDir, hex.EncodeToString(key), source)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dataDir, "registry", "sync-required")
	if err := os.Mkdir(marker, 0700); err != nil {
		t.Fatal(err)
	}
	if err := m.MarkDirty("v2"); err == nil {
		t.Fatal("dirty marker persistence unexpectedly succeeded")
	}
	if _, _, err := m.Acquire(); err == nil {
		t.Fatal("authentication remained available after dirty marker failure")
	}
}
