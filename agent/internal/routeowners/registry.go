package routeowners

import (
	"strings"
	"sync"
)

// Registry retains resource ownership for the lifetime of the process.
type Registry struct {
	mu     sync.RWMutex
	owners map[string]string
}

func NewRegistry() *Registry {
	return &Registry{owners: make(map[string]string)}
}

func (r *Registry) Merge(owners map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for resource, serviceID := range owners {
		if resource != "" && serviceID != "" {
			r.owners[resource] = serviceID
		}
	}
}

func (r *Registry) Lookup(resource string) (string, bool) {
	resource = strings.TrimSuffix(resource, "@file")
	r.mu.RLock()
	defer r.mu.RUnlock()
	serviceID, ok := r.owners[resource]
	return serviceID, ok
}
