package caddy

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"

	pb "techulus/cloud-agent/internal/proto"
)

const (
	caddyAdminURL = "http://localhost:2019"
	routesPath    = "/config/apps/http/servers/srv0/routes"
)

var lastConfigHash string

func CheckPrerequisites() error {
	if _, err := exec.LookPath("caddy"); err != nil {
		return fmt.Errorf("caddy command not found: %w", err)
	}
	return nil
}

func buildCaddyRoute(route *pb.CaddyRoute) map[string]any {
	upstreams := make([]map[string]string, len(route.Upstreams))
	for i, u := range route.Upstreams {
		upstreams[i] = map[string]string{"dial": u}
	}

	caddyRoute := map[string]any{
		"@id": route.Id,
		"match": []map[string]any{
			{"host": []string{route.Domain}},
		},
		"handle": []map[string]any{
			{
				"handler":   "reverse_proxy",
				"upstreams": upstreams,
			},
		},
	}

	if route.Internal {
		caddyRoute["terminal"] = true
	}

	return caddyRoute
}

func hashConfig(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func getExistingRoutes() ([]map[string]any, error) {
	resp, err := http.Get(caddyAdminURL + routesPath)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return []map[string]any{}, nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var routes []map[string]any
	if err := json.Unmarshal(body, &routes); err != nil {
		return []map[string]any{}, nil
	}

	return routes, nil
}

func HandleCaddyConfig(config *pb.CaddyConfig) (bool, error) {
	var managedRoutes []map[string]any
	for _, route := range config.Routes {
		if len(route.Upstreams) == 0 {
			continue
		}
		managedRoutes = append(managedRoutes, buildCaddyRoute(route))
	}

	managedJSON, _ := json.Marshal(managedRoutes)
	configHash := hashConfig(managedJSON)

	if configHash == lastConfigHash {
		return true, nil
	}

	existingRoutes, err := getExistingRoutes()
	if err != nil {
		existingRoutes = []map[string]any{}
	}

	var newRoutes []map[string]any
	for _, r := range existingRoutes {
		if _, hasID := r["@id"]; !hasID {
			newRoutes = append(newRoutes, r)
		}
	}
	newRoutes = append(newRoutes, managedRoutes...)

	routesJSON, _ := json.Marshal(newRoutes)
	req, _ := http.NewRequest("PATCH", caddyAdminURL+routesPath, bytes.NewReader(routesJSON))
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return false, fmt.Errorf("caddy PATCH returned %d: %s", resp.StatusCode, string(body))
	}

	lastConfigHash = configHash
	return true, nil
}
