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
	"sort"
	"strings"
	"time"

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

type CaddyRoute struct {
	ID        string
	Domain    string
	Upstreams []string
	ServiceId string
}

func UpdateCaddyRoutes(routes []CaddyRoute) error {
	var managedRoutes []map[string]any
	for _, route := range routes {
		if len(route.Upstreams) == 0 {
			continue
		}

		upstreams := make([]map[string]string, len(route.Upstreams))
		for i, u := range route.Upstreams {
			upstreams[i] = map[string]string{"dial": u}
		}

		caddyRoute := map[string]any{
			"@id": route.ID,
			"match": []map[string]any{
				{"host": []string{route.Domain}},
			},
			"handle": []map[string]any{
				{
					"handler":    "vars",
					"service_id": route.ServiceId,
				},
				{
					"handler": "log_append",
					"key":     "service_id",
					"value":   "{http.vars.service_id}",
				},
				{
					"handler":   "reverse_proxy",
					"upstreams": upstreams,
				},
			},
		}
		managedRoutes = append(managedRoutes, caddyRoute)
	}

	managedJSON, _ := json.Marshal(managedRoutes)
	configHash := hashConfig(managedJSON)

	if configHash == lastConfigHash {
		return nil
	}

	log.Printf("[caddy] updating %d routes", len(routes))

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
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("caddy PATCH returned %d: %s", resp.StatusCode, string(body))
	}

	if len(routes) == 0 {
		lastConfigHash = configHash
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	log.Printf("[caddy] verifying routes...")
	var failedRoutes []string

	for _, route := range routes {
		if len(route.Upstreams) == 0 {
			continue
		}

		err := retry.WithBackoff(ctx, retry.ConfigBackoff, func() (bool, error) {
			verified, err := VerifyRouteExists(route.ID, route.Domain)
			if err != nil {
				log.Printf("[caddy:verify] route %s verification error: %v", route.ID, err)
				return false, nil
			}
			return verified, nil
		})

		if err != nil {
			failedRoutes = append(failedRoutes, route.ID)
			log.Printf("[caddy:verify] route %s verification failed after retries", route.ID)
		} else {
			log.Printf("[caddy:verify] route %s verified successfully", route.ID)
		}
	}

	if len(failedRoutes) > 0 {
		return fmt.Errorf("failed to verify routes: %v", failedRoutes)
	}

	lastConfigHash = configHash
	log.Printf("[caddy] all routes verified successfully")
	return nil
}

func HashRoutes(routes []CaddyRoute) string {
	sortedRoutes := make([]CaddyRoute, len(routes))
	copy(sortedRoutes, routes)
	sort.Slice(sortedRoutes, func(i, j int) bool {
		return sortedRoutes[i].ID < sortedRoutes[j].ID
	})

	var sb strings.Builder
	for _, r := range sortedRoutes {
		sb.WriteString(r.ID)
		sb.WriteString(":")
		sb.WriteString(r.Domain)
		sb.WriteString(":")
		sb.WriteString(r.ServiceId)
		sb.WriteString(":")
		sortedUpstreams := make([]string, len(r.Upstreams))
		copy(sortedUpstreams, r.Upstreams)
		sort.Strings(sortedUpstreams)
		sb.WriteString(strings.Join(sortedUpstreams, ","))
		sb.WriteString("|")
	}
	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}

func GetCurrentConfigHash() string {
	routes, err := getExistingRoutes()
	if err != nil {
		log.Printf("[caddy:hash] failed to get routes: %v", err)
		return ""
	}

	var managedRoutes []CaddyRoute
	for _, route := range routes {
		id, hasID := route["@id"].(string)
		if !hasID || id == "" {
			continue
		}

		var domain string
		var upstreams []string

		if matchList, ok := route["match"].([]any); ok && len(matchList) > 0 {
			if firstMatch, ok := matchList[0].(map[string]any); ok {
				if hostList, ok := firstMatch["host"].([]any); ok && len(hostList) > 0 {
					if h, ok := hostList[0].(string); ok {
						domain = h
					}
				}
			}
		}

		var serviceId string
		if handleList, ok := route["handle"].([]any); ok {
			for _, h := range handleList {
				handler, ok := h.(map[string]any)
				if !ok {
					continue
				}
				handlerType, _ := handler["handler"].(string)
				if handlerType == "vars" {
					if sid, ok := handler["service_id"].(string); ok {
						serviceId = sid
					}
				}
				if handlerType == "reverse_proxy" {
					if upstreamList, ok := handler["upstreams"].([]any); ok {
						for _, u := range upstreamList {
							if upstream, ok := u.(map[string]any); ok {
								if dial, ok := upstream["dial"].(string); ok {
									upstreams = append(upstreams, dial)
								}
							}
						}
					}
				}
			}
		}

		managedRoutes = append(managedRoutes, CaddyRoute{
			ID:        id,
			Domain:    domain,
			Upstreams: upstreams,
			ServiceId: serviceId,
		})
	}

	return HashRoutes(managedRoutes)
}

