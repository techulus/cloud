// Package network provides utilities for discovering public and private IP addresses.
package network

import (
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/hashicorp/go-sockaddr"
)

func PublicIP() string {
	ip, err := sockaddr.GetPublicIP()
	if err == nil && ip != "" {
		return ip
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("https://api.ipify.org")
	if err != nil {
		log.Printf("Failed to get public IP from ipify: %v", err)
		return ""
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Failed to read ipify response: %v", err)
		return ""
	}

	return strings.TrimSpace(string(body))
}

func PrivateIP() string {
	ips, err := sockaddr.GetPrivateIPs()
	if err != nil {
		log.Printf("Failed to get private IPs: %v", err)
		return ""
	}

	for ip := range strings.SplitSeq(ips, " ") {
		if ip == "" {
			continue
		}
		if strings.HasPrefix(ip, "10.100.") || strings.HasPrefix(ip, "10.200.") {
			continue
		}
		return ip
	}

	return ""
}
