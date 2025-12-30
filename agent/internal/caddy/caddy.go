package caddy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"time"

	pb "techulus/cloud-agent/internal/proto"
	"techulus/cloud-agent/internal/retry"
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

func VerifyRouteExists(routeID string, expectedDomain string) (bool, error) {
	routes, err := getExistingRoutes()
	if err != nil {
		return false, fmt.Errorf("failed to get existing routes: %w", err)
	}

	for _, route := range routes {
		id, ok := route["@id"].(string)
		if !ok || id != routeID {
			continue
		}

		matchList, ok := route["match"].([]any)
		if !ok || len(matchList) == 0 {
			continue
		}

		firstMatch, ok := matchList[0].(map[string]any)
		if !ok {
			continue
		}

		hostList, ok := firstMatch["host"].([]any)
		if !ok || len(hostList) == 0 {
			continue
		}

		for _, h := range hostList {
			if host, ok := h.(string); ok && host == expectedDomain {
				return true, nil
			}
		}
	}

	return false, nil
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

	log.Printf("[caddy] updating %d routes", len(config.Routes))

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

	if len(config.Routes) == 0 {
		lastConfigHash = configHash
		return true, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	log.Printf("[caddy] verifying routes...")
	var failedRoutes []string

	for _, route := range config.Routes {
		if len(route.Upstreams) == 0 {
			continue
		}

		err := retry.WithBackoff(ctx, retry.ConfigBackoff, func() (bool, error) {
			verified, err := VerifyRouteExists(route.Id, route.Domain)
			if err != nil {
				log.Printf("[caddy:verify] route %s verification error: %v", route.Id, err)
				return false, nil
			}
			return verified, nil
		})

		if err != nil {
			failedRoutes = append(failedRoutes, route.Id)
			log.Printf("[caddy:verify] route %s verification failed after retries", route.Id)
		} else {
			log.Printf("[caddy:verify] route %s verified successfully", route.Id)
		}
	}

	if len(failedRoutes) > 0 {
		return false, fmt.Errorf("failed to verify routes: %v", failedRoutes)
	}

	lastConfigHash = configHash
	log.Printf("[caddy] all routes verified successfully")
	return true, nil
}
