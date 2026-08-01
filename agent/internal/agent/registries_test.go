package agent

import (
	"context"
	"errors"
	"testing"

	agenthttp "techulus/cloud-agent/internal/http"
	"techulus/cloud-agent/internal/registryauth"
)

type failingRegistryBundleSource struct{}

func (failingRegistryBundleSource) GetRegistryBundle(context.Context) (*registryauth.Bundle, error) {
	return nil, errors.New("control plane unavailable")
}

func TestProcessSyncRegistriesMarksAuthenticationDirtyBeforeFetch(t *testing.T) {
	manager, err := registryauth.NewManager(t.TempDir(), "00", failingRegistryBundleSource{})
	if err != nil {
		t.Fatal(err)
	}
	a := &Agent{RegistryAuth: manager}
	err = a.ProcessSyncRegistries(agenthttp.WorkQueueItem{
		Type:    "sync_registries",
		Payload: `{"version":"v2"}`,
	})
	if err == nil {
		t.Fatal("sync unexpectedly succeeded")
	}
	if _, _, err := manager.Acquire(); err == nil {
		t.Fatal("registry authentication remained usable after failed required sync")
	}
}

func TestProcessSyncRegistriesRejectsInvalidPayload(t *testing.T) {
	manager, err := registryauth.NewManager(t.TempDir(), "00", failingRegistryBundleSource{})
	if err != nil {
		t.Fatal(err)
	}
	a := &Agent{RegistryAuth: manager}
	if err := a.ProcessSyncRegistries(agenthttp.WorkQueueItem{Payload: `{}`}); err == nil {
		t.Fatal("invalid payload was accepted")
	}
}
