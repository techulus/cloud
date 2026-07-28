package routeowners

import "testing"

func TestRegistryRetainsOwnersAndHandlesFileSuffix(t *testing.T) {
	registry := NewRegistry()
	registry.Merge(map[string]string{"http-old": "service-old"})
	registry.Merge(map[string]string{
		"http-new": "service-new",
	})

	for resource, want := range map[string]string{
		"http-old@file": "service-old",
		"http-new":      "service-new",
	} {
		got, ok := registry.Lookup(resource)
		if !ok || got != want {
			t.Fatalf("Lookup(%q) = %q, %t; want %q, true", resource, got, ok, want)
		}
	}

	if _, ok := registry.Lookup("http-old@docker"); ok {
		t.Fatal("non-file provider suffix unexpectedly matched")
	}
}
