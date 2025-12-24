package crypto

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
)

type KeyPair struct {
	PublicKey  ed25519.PublicKey
	PrivateKey ed25519.PrivateKey
}

func GenerateKeyPair() (*KeyPair, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("failed to generate key pair: %w", err)
	}
	return &KeyPair{
		PublicKey:  pub,
		PrivateKey: priv,
	}, nil
}

func (kp *KeyPair) PublicKeyBase64() string {
	return base64.StdEncoding.EncodeToString(kp.PublicKey)
}

func (kp *KeyPair) Sign(message []byte) string {
	sig := ed25519.Sign(kp.PrivateKey, message)
	return base64.StdEncoding.EncodeToString(sig)
}

func (kp *KeyPair) SaveToFile(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create key directory: %w", err)
	}

	privPath := filepath.Join(dir, "private.key")
	pubPath := filepath.Join(dir, "public.key")

	if err := os.WriteFile(privPath, kp.PrivateKey, 0600); err != nil {
		return fmt.Errorf("failed to write private key: %w", err)
	}

	if err := os.WriteFile(pubPath, kp.PublicKey, 0644); err != nil {
		return fmt.Errorf("failed to write public key: %w", err)
	}

	return nil
}

func LoadKeyPair(dir string) (*KeyPair, error) {
	privPath := filepath.Join(dir, "private.key")
	pubPath := filepath.Join(dir, "public.key")

	priv, err := os.ReadFile(privPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read private key: %w", err)
	}

	pub, err := os.ReadFile(pubPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read public key: %w", err)
	}

	return &KeyPair{
		PublicKey:  ed25519.PublicKey(pub),
		PrivateKey: ed25519.PrivateKey(priv),
	}, nil
}

func KeyPairExists(dir string) bool {
	privPath := filepath.Join(dir, "private.key")
	_, err := os.Stat(privPath)
	return err == nil
}
