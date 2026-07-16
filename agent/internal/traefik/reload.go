package traefik

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	lastReloadSuccessMetric = "traefik_config_last_reload_success"
	pendingReloadMarkerName = ".routing-reload-pending"
)

var (
	traefikMetricsURL        = "http://127.0.0.1:9100/metrics"
	dynamicConfigDir         = traefikDynamicDir
	metricsHTTPClient        = &http.Client{Timeout: 2 * time.Second}
	readLastSuccessfulReload = fetchLastSuccessfulReload
	restartTraefik           = ReloadTraefik
	reloadPollInterval       = 250 * time.Millisecond
)

func LastSuccessfulReload() (time.Time, error) {
	return readLastSuccessfulReload()
}

func fetchLastSuccessfulReload() (time.Time, error) {
	response, err := metricsHTTPClient.Get(traefikMetricsURL)
	if err != nil {
		return time.Time{}, fmt.Errorf("failed to read Traefik metrics: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return time.Time{}, fmt.Errorf("Traefik metrics returned %s", response.Status)
	}
	return parseLastSuccessfulReload(response.Body)
}

func parseLastSuccessfulReload(reader io.Reader) (time.Time, error) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 || fields[0] != lastReloadSuccessMetric {
			continue
		}
		seconds, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid %s value: %w", lastReloadSuccessMetric, err)
		}
		wholeSeconds := int64(seconds)
		nanoseconds := int64((seconds - float64(wholeSeconds)) * float64(time.Second))
		return time.Unix(wholeSeconds, nanoseconds), nil
	}
	if err := scanner.Err(); err != nil {
		return time.Time{}, fmt.Errorf("failed to parse Traefik metrics: %w", err)
	}
	return time.Time{}, fmt.Errorf("%s metric not found", lastReloadSuccessMetric)
}

func newestDynamicConfigModTime() (time.Time, error) {
	var newest time.Time
	for _, name := range []string{tlsFileName, routesFileName} {
		info, err := os.Stat(filepath.Join(dynamicConfigDir, name))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return time.Time{}, err
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	return newest, nil
}

func DynamicConfigReloaded(stateDir string) (bool, error) {
	if _, err := os.Stat(pendingReloadMarkerPath(stateDir)); err == nil {
		return false, nil
	} else if !os.IsNotExist(err) {
		return false, fmt.Errorf("failed to inspect Traefik reload marker: %w", err)
	}

	lastReload, err := LastSuccessfulReload()
	if err != nil {
		return false, err
	}
	return dynamicFilesReloaded(lastReload)
}

func dynamicFilesReloaded(lastReload time.Time) (bool, error) {
	newestConfig, err := newestDynamicConfigModTime()
	if err != nil {
		return false, fmt.Errorf("failed to inspect Traefik dynamic config: %w", err)
	}
	if newestConfig.IsZero() {
		return true, nil
	}

	// Traefik currently exposes this metric with second precision. Comparing
	// second-truncated values preserves the durable post-restart check while the
	// write path separately requires the metric to advance from its baseline.
	return !lastReload.Before(newestConfig.Truncate(time.Second)), nil
}

func MarkDynamicConfigReloadPending(stateDir string) error {
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		return err
	}
	return atomicWrite(pendingReloadMarkerPath(stateDir), nil, 0644)
}

func EnsureDynamicConfigReloaded(stateDir string, timeout time.Duration) error {
	lastReload, err := LastSuccessfulReload()
	if err != nil {
		return err
	}
	reloaded, err := dynamicFilesReloaded(lastReload)
	if err != nil {
		return err
	}
	if reloaded {
		return clearPendingReloadMarker(stateDir)
	}

	if err := MarkDynamicConfigReloadPending(stateDir); err != nil {
		return err
	}
	if err := restartTraefik(); err != nil {
		return err
	}
	return WaitForSuccessfulReloadAfter(stateDir, lastReload, timeout)
}

func WaitForSuccessfulReloadAfter(stateDir string, baseline time.Time, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		lastReload, err := LastSuccessfulReload()
		if err == nil && lastReload.After(baseline) {
			reloaded, reloadErr := dynamicFilesReloaded(lastReload)
			if reloadErr == nil && reloaded {
				return clearPendingReloadMarker(stateDir)
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("Traefik did not confirm a successful config reload within %s", timeout)
		}
		time.Sleep(reloadPollInterval)
	}
}

func pendingReloadMarkerPath(stateDir string) string {
	return filepath.Join(stateDir, pendingReloadMarkerName)
}

func clearPendingReloadMarker(stateDir string) error {
	if err := os.Remove(pendingReloadMarkerPath(stateDir)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to clear Traefik reload marker: %w", err)
	}
	return nil
}
