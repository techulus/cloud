package traefik

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseLastSuccessfulReload(t *testing.T) {
	reload, err := parseLastSuccessfulReload(strings.NewReader(`# HELP traefik_config_last_reload_success Last config reload success
traefik_config_last_reload_success 1.725e+09
`))
	if err != nil {
		t.Fatalf("parseLastSuccessfulReload returned an error: %v", err)
	}
	if got, want := reload.Unix(), int64(1725000000); got != want {
		t.Fatalf("reload timestamp = %d, want %d", got, want)
	}
}

func TestDynamicConfigReloadedRequiresReloadAtOrAfterNewestFile(t *testing.T) {
	originalDir := dynamicConfigDir
	originalReader := readLastSuccessfulReload
	t.Cleanup(func() {
		dynamicConfigDir = originalDir
		readLastSuccessfulReload = originalReader
	})

	var reloadTimestamp int64 = 100
	readLastSuccessfulReload = func() (time.Time, error) {
		return time.Unix(reloadTimestamp, 0), nil
	}
	dynamicConfigDir = t.TempDir()
	stateDir := t.TempDir()

	routesPath := filepath.Join(dynamicConfigDir, routesFileName)
	if err := os.WriteFile(routesPath, []byte("http: {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	configTime := time.Unix(101, 500)
	if err := os.Chtimes(routesPath, configTime, configTime); err != nil {
		t.Fatal(err)
	}

	reloaded, err := DynamicConfigReloaded(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded {
		t.Fatal("config was reported as reloaded before the file modification time")
	}

	reloadTimestamp = 102
	markerPath := pendingReloadMarkerPath(stateDir)
	if err := os.WriteFile(markerPath, []byte("pending"), 0644); err != nil {
		t.Fatal(err)
	}
	reloaded, err = DynamicConfigReloaded(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded {
		t.Fatal("config was reported as reloaded while its durable marker was pending")
	}
	if err := os.Remove(markerPath); err != nil {
		t.Fatal(err)
	}

	reloaded, err = DynamicConfigReloaded(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded {
		t.Fatal("config was not reported as reloaded after the file modification time")
	}
}

func TestWaitForSuccessfulReloadClearsPendingMarker(t *testing.T) {
	originalDir := dynamicConfigDir
	originalReader := readLastSuccessfulReload
	t.Cleanup(func() {
		dynamicConfigDir = originalDir
		readLastSuccessfulReload = originalReader
	})

	dynamicConfigDir = t.TempDir()
	stateDir := t.TempDir()
	baseline := time.Unix(100, 0)
	readLastSuccessfulReload = func() (time.Time, error) {
		return baseline.Add(2 * time.Second), nil
	}
	routesPath := filepath.Join(dynamicConfigDir, routesFileName)
	if err := os.WriteFile(routesPath, []byte("http: {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(routesPath, baseline.Add(time.Second), baseline.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := MarkDynamicConfigReloadPending(stateDir); err != nil {
		t.Fatal(err)
	}

	if err := WaitForSuccessfulReloadAfter(stateDir, baseline, time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(pendingReloadMarkerPath(stateDir)); !os.IsNotExist(err) {
		t.Fatalf("pending marker was not removed: %v", err)
	}
}

func TestEnsureDynamicConfigReloadedRecoversIdenticalConfigWithoutRestart(t *testing.T) {
	originalDir := dynamicConfigDir
	originalReader := readLastSuccessfulReload
	originalRestart := restartTraefik
	t.Cleanup(func() {
		dynamicConfigDir = originalDir
		readLastSuccessfulReload = originalReader
		restartTraefik = originalRestart
	})

	dynamicConfigDir = t.TempDir()
	stateDir := t.TempDir()
	configTime := time.Unix(101, 0)
	routesPath := filepath.Join(dynamicConfigDir, routesFileName)
	if err := os.WriteFile(routesPath, []byte("http: {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(routesPath, configTime, configTime); err != nil {
		t.Fatal(err)
	}
	readLastSuccessfulReload = func() (time.Time, error) {
		return configTime.Add(time.Second), nil
	}
	restartCount := 0
	restartTraefik = func() error {
		restartCount++
		return nil
	}
	if err := MarkDynamicConfigReloadPending(stateDir); err != nil {
		t.Fatal(err)
	}

	if err := EnsureDynamicConfigReloaded(stateDir, time.Second); err != nil {
		t.Fatal(err)
	}
	if restartCount != 0 {
		t.Fatalf("Traefik restarted %d times for an already-loaded config", restartCount)
	}
	if _, err := os.Stat(pendingReloadMarkerPath(stateDir)); !os.IsNotExist(err) {
		t.Fatalf("pending marker was not removed: %v", err)
	}
}

func TestEnsureDynamicConfigReloadedRestartsForStaleConfig(t *testing.T) {
	originalDir := dynamicConfigDir
	originalReader := readLastSuccessfulReload
	originalRestart := restartTraefik
	t.Cleanup(func() {
		dynamicConfigDir = originalDir
		readLastSuccessfulReload = originalReader
		restartTraefik = originalRestart
	})

	dynamicConfigDir = t.TempDir()
	stateDir := t.TempDir()
	configTime := time.Unix(101, 0)
	routesPath := filepath.Join(dynamicConfigDir, routesFileName)
	if err := os.WriteFile(routesPath, []byte("http: {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(routesPath, configTime, configTime); err != nil {
		t.Fatal(err)
	}
	reloadTime := time.Unix(100, 0)
	readLastSuccessfulReload = func() (time.Time, error) {
		return reloadTime, nil
	}
	restartCount := 0
	restartTraefik = func() error {
		restartCount++
		reloadTime = configTime.Add(time.Second)
		return nil
	}

	if err := EnsureDynamicConfigReloaded(stateDir, time.Second); err != nil {
		t.Fatal(err)
	}
	if restartCount != 1 {
		t.Fatalf("Traefik restarted %d times, want 1", restartCount)
	}
	if _, err := os.Stat(pendingReloadMarkerPath(stateDir)); !os.IsNotExist(err) {
		t.Fatalf("pending marker was not removed: %v", err)
	}
}

func TestWaitForSuccessfulReloadTimesOutAndKeepsMarker(t *testing.T) {
	originalReader := readLastSuccessfulReload
	originalPollInterval := reloadPollInterval
	t.Cleanup(func() {
		readLastSuccessfulReload = originalReader
		reloadPollInterval = originalPollInterval
	})

	stateDir := t.TempDir()
	baseline := time.Unix(100, 0)
	readLastSuccessfulReload = func() (time.Time, error) {
		return baseline, nil
	}
	reloadPollInterval = time.Millisecond
	if err := MarkDynamicConfigReloadPending(stateDir); err != nil {
		t.Fatal(err)
	}

	err := WaitForSuccessfulReloadAfter(stateDir, baseline, 5*time.Millisecond)
	if err == nil {
		t.Fatal("reload wait unexpectedly succeeded without a newer metric")
	}
	if _, statErr := os.Stat(pendingReloadMarkerPath(stateDir)); statErr != nil {
		t.Fatalf("pending marker should remain after timeout: %v", statErr)
	}
}
