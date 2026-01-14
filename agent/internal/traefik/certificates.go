package traefik

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

func UpdateCertificates(certs []Certificate) error {
	if err := os.MkdirAll(traefikCertsDir, 0700); err != nil {
		return fmt.Errorf("failed to create certs dir: %w", err)
	}

	for _, cert := range certs {
		certPath := filepath.Join(traefikCertsDir, cert.Domain+".crt")
		keyPath := filepath.Join(traefikCertsDir, cert.Domain+".key")

		if err := atomicWrite(certPath, []byte(cert.Certificate), 0600); err != nil {
			return fmt.Errorf("failed to write cert for %s: %w", cert.Domain, err)
		}
		if err := atomicWrite(keyPath, []byte(cert.CertificateKey), 0600); err != nil {
			return fmt.Errorf("failed to write key for %s: %w", cert.Domain, err)
		}
	}

	return writeTLSConfig(certs)
}

func writeTLSConfig(certs []Certificate) error {
	config := tlsFileConfig{
		TLS: tlsSection{
			Certificates: make([]certEntry, len(certs)),
		},
	}

	for i, cert := range certs {
		config.TLS.Certificates[i] = certEntry{
			CertFile: filepath.Join(traefikCertsDir, cert.Domain+".crt"),
			KeyFile:  filepath.Join(traefikCertsDir, cert.Domain+".key"),
		}
	}

	data, err := yaml.Marshal(config)
	if err != nil {
		return fmt.Errorf("failed to marshal TLS config: %w", err)
	}

	if err := os.MkdirAll(traefikDynamicDir, 0755); err != nil {
		return fmt.Errorf("failed to create dynamic config dir: %w", err)
	}

	tlsPath := filepath.Join(traefikDynamicDir, tlsFileName)
	if err := atomicWrite(tlsPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write TLS config: %w", err)
	}

	log.Printf("[traefik] TLS config updated with %d certificates", len(certs))
	return nil
}

func HashCertificates(certs []Certificate) string {
	sortedCerts := make([]Certificate, len(certs))
	copy(sortedCerts, certs)
	sort.Slice(sortedCerts, func(i, j int) bool {
		return sortedCerts[i].Domain < sortedCerts[j].Domain
	})

	var sb strings.Builder
	for _, c := range sortedCerts {
		sb.WriteString(c.Domain)
		sb.WriteString(":")
		h := sha256.Sum256([]byte(c.Certificate + "|" + c.CertificateKey))
		sb.WriteString(hex.EncodeToString(h[:8]))
		sb.WriteString("|")
	}
	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}

func GetCurrentCertificatesHash() string {
	certs, err := readCurrentCertificates()
	if err != nil {
		log.Printf("[traefik:hash] failed to read certs: %v", err)
		return ""
	}
	return HashCertificates(certs)
}

func readCurrentCertificates() ([]Certificate, error) {
	tlsPath := filepath.Join(traefikDynamicDir, tlsFileName)
	data, err := os.ReadFile(tlsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var config tlsFileConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	var certs []Certificate
	for _, entry := range config.TLS.Certificates {
		domain := strings.TrimSuffix(filepath.Base(entry.CertFile), ".crt")
		certData, err := os.ReadFile(entry.CertFile)
		if err != nil {
			log.Printf("[traefik] warning: failed to read cert file %s: %v", entry.CertFile, err)
			continue
		}
		keyData, err := os.ReadFile(entry.KeyFile)
		if err != nil {
			log.Printf("[traefik] warning: failed to read key file %s: %v", entry.KeyFile, err)
			continue
		}
		certs = append(certs, Certificate{
			Domain:         domain,
			Certificate:    string(certData),
			CertificateKey: string(keyData),
		})
	}

	return certs, nil
}
