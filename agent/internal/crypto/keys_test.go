package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

func TestDecryptRegistryCredentialAAD(t *testing.T) {
	key := make([]byte, 32)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	iv := make([]byte, gcm.NonceSize())
	aad := []byte("registry-credential:v1\x00id-1\x00docker.io")
	sealed := gcm.Seal(nil, iv, []byte("password"), aad)
	framed := append(append([]byte{}, iv...), sealed[len(sealed)-gcm.Overhead():]...)
	framed = append(framed, sealed[:len(sealed)-gcm.Overhead()]...)
	encoded := base64.StdEncoding.EncodeToString(framed)

	got, err := DecryptRegistryCredential(encoded, hex.EncodeToString(key), "id-1", "docker.io")
	if err != nil || got != "password" {
		t.Fatalf("decrypt = %q, %v", got, err)
	}
	if _, err := DecryptRegistryCredential(encoded, hex.EncodeToString(key), "id-2", "docker.io"); err == nil {
		t.Fatal("decrypt succeeded with wrong AAD")
	}
}
