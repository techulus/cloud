// Package for managing proxy setup and configurations
package caddy

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"

	pb "techulus/cloud-agent/internal/proto"
)

const (
	caddyAdminURL = "http://localhost:2019"
)

var lastCaddyConfigHash string

func CheckPrerequisites() error {
	if _, err := exec.LookPath("caddy"); err != nil {
		return fmt.Errorf("caddy command not found: %w", err)
	}
	return nil
}

func GetCaddyRoutes(isProxy bool) []*pb.ProxyRouteInfo {
	if !isProxy {
		return nil
	}

	resp, err := http.Get(caddyAdminURL + "/config/apps/http/servers/srv0/routes")
	if err != nil {
		log.Printf("Failed to get Caddy routes: %v", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Failed to read Caddy routes response: %v", err)
		return nil
	}

	var routes []struct {
		ID    string `json:"@id"`
		Match []struct {
			Host []string `json:"host"`
		} `json:"match"`
		Handle []struct {
			Handler   string `json:"handler"`
			Upstreams []struct {
				Dial string `json:"dial"`
			} `json:"upstreams"`
		} `json:"handle"`
	}

	if err := json.Unmarshal(body, &routes); err != nil {
		log.Printf("Failed to parse Caddy routes: %v", err)
		return nil
	}

	var proxyRoutes []*pb.ProxyRouteInfo
	for _, route := range routes {
		if route.ID == "" {
			continue
		}

		var domain string
		if len(route.Match) > 0 && len(route.Match[0].Host) > 0 {
			domain = route.Match[0].Host[0]
		}

		var upstreams []string
		for _, handle := range route.Handle {
			if handle.Handler == "reverse_proxy" {
				for _, upstream := range handle.Upstreams {
					upstreams = append(upstreams, upstream.Dial)
				}
			}
		}

		proxyRoutes = append(proxyRoutes, &pb.ProxyRouteInfo{
			RouteId:   route.ID,
			Domain:    domain,
			Upstreams: upstreams,
		})
	}

	return proxyRoutes
}

func HandleCaddyConfig(config *pb.CaddyConfig) {
	routes := make([]any, 0, len(config.Routes))
	for _, route := range config.Routes {
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

		routes = append(routes, caddyRoute)
	}

	routesJSON, err := json.Marshal(routes)
	if err != nil {
		log.Printf("Failed to marshal caddy routes: %v", err)
		return
	}

	hash := sha256.Sum256(routesJSON)
	hashStr := hex.EncodeToString(hash[:])

	if hashStr == lastCaddyConfigHash {
		return
	}

	endpoint := caddyAdminURL + "/config/apps/http/servers/srv0/routes"

	req, err := http.NewRequest("PATCH", endpoint, bytes.NewReader(routesJSON))
	if err != nil {
		log.Printf("Failed to create caddy request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("Failed to update caddy routes: %v", err)
		return
	}

	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		req, err = http.NewRequest("PUT", endpoint, bytes.NewReader(routesJSON))
		if err != nil {
			log.Printf("Failed to create caddy request: %v", err)
			return
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err = http.DefaultClient.Do(req)
		if err != nil {
			log.Printf("Failed to create caddy routes: %v", err)
			return
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("Caddy returned %d: %s", resp.StatusCode, body)
		return
	}

	lastCaddyConfigHash = hashStr
	log.Printf("Synced %d routes to Caddy via gRPC push", len(routes))
}

