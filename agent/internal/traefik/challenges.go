package traefik

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

func controlPlaneHost(controlPlaneUrl string) string {
	if strings.HasPrefix(controlPlaneUrl, "https://") {
		return strings.TrimPrefix(controlPlaneUrl, "https://")
	}
	if strings.HasPrefix(controlPlaneUrl, "http://") {
		return strings.TrimPrefix(controlPlaneUrl, "http://")
	}
	return controlPlaneUrl
}

func WriteChallengeRoute(controlPlaneUrl string) error {
	config := challengeConfig{
		HTTP: httpConfigWithMiddlewares{
			Routers: map[string]routerWithMiddleware{
				"acme_challenge": {
					Rule:        "PathPrefix(`/.well-known/acme-challenge/`)",
					EntryPoints: []string{"web"},
					Service:     "acme_challenge_svc",
					Middlewares: []string{"acme_rewrite@file", "acme_headers@file"},
					Priority:    9999,
				},
				"http_to_https": {
					Rule:        "HostRegexp(`.*`)",
					EntryPoints: []string{"web"},
					Middlewares: []string{"redirect_https@file"},
					Service:     "noop@internal",
					Priority:    1,
				},
			},
			Services: map[string]service{
				"acme_challenge_svc": {
					LoadBalancer: loadBalancer{
						Servers: []server{
							{URL: controlPlaneUrl},
						},
					},
				},
			},
			Middlewares: map[string]middleware{
				"acme_rewrite": {
					ReplacePathRegex: &replacePathRegex{
						Regex:       "^/.well-known/acme-challenge/(.*)",
						Replacement: "/api/v1/acme/challenge/$1",
					},
				},
				"acme_headers": {
					Headers: &headersMiddleware{
						CustomRequestHeaders: map[string]string{
							"Host": controlPlaneHost(controlPlaneUrl),
						},
					},
				},
				"redirect_https": {
					RedirectScheme: &redirectScheme{
						Scheme:    "https",
						Permanent: true,
					},
				},
			},
		},
	}

	data, err := yaml.Marshal(config)
	if err != nil {
		return fmt.Errorf("failed to marshal challenge route config: %w", err)
	}

	if err := os.MkdirAll(traefikDynamicDir, 0755); err != nil {
		return fmt.Errorf("failed to create dynamic config dir: %w", err)
	}

	challengePath := filepath.Join(traefikDynamicDir, challengesFileName)
	if err := atomicWrite(challengePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write challenge route config: %w", err)
	}

	log.Printf("[traefik] challenge route written pointing to %s", controlPlaneUrl)
	return nil
}

func ChallengeRouteExists() bool {
	challengePath := filepath.Join(traefikDynamicDir, challengesFileName)
	_, err := os.Stat(challengePath)
	return err == nil
}
