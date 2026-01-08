package dns

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

type RecordStore struct {
	mu      sync.RWMutex
	records map[string][]net.IP
	rrIndex map[string]*uint32
	hash    string
}

func NewRecordStore() *RecordStore {
	return &RecordStore{
		records: make(map[string][]net.IP),
		rrIndex: make(map[string]*uint32),
	}
}

func (s *RecordStore) Update(records []DnsRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()

	newRecords := make(map[string][]net.IP)
	newRRIndex := make(map[string]*uint32)

	for _, r := range records {
		name := normalizeName(r.Name)
		ips := make([]net.IP, 0, len(r.Ips))
		for _, ipStr := range r.Ips {
			if ip := net.ParseIP(ipStr); ip != nil {
				ips = append(ips, ip)
			}
		}
		if len(ips) > 0 {
			newRecords[name] = ips
			idx := uint32(0)
			newRRIndex[name] = &idx
		}
	}

	s.records = newRecords
	s.rrIndex = newRRIndex
	s.hash = hashRecordsInternal(records)
}

func (s *RecordStore) Lookup(name string) []net.IP {
	s.mu.RLock()
	defer s.mu.RUnlock()

	normalName := normalizeName(name)
	ips := s.records[normalName]
	if len(ips) <= 1 {
		return ips
	}

	idxPtr := s.rrIndex[normalName]
	if idxPtr == nil {
		return ips
	}

	idx := atomic.AddUint32(idxPtr, 1) % uint32(len(ips))
	rotated := make([]net.IP, len(ips))
	for i := range ips {
		rotated[i] = ips[(int(idx)+i)%len(ips)]
	}
	return rotated
}

func (s *RecordStore) Hash() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.hash
}

func normalizeName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if !strings.HasSuffix(name, ".") {
		name = name + "."
	}
	return name
}

func hashRecordsInternal(records []DnsRecord) string {
	sortedRecords := make([]DnsRecord, len(records))
	copy(sortedRecords, records)
	sort.Slice(sortedRecords, func(i, j int) bool {
		return sortedRecords[i].Name < sortedRecords[j].Name
	})

	var sb strings.Builder
	for _, r := range sortedRecords {
		sb.WriteString(r.Name)
		sb.WriteString(":")
		sortedIps := make([]string, len(r.Ips))
		copy(sortedIps, r.Ips)
		sort.Strings(sortedIps)
		sb.WriteString(strings.Join(sortedIps, ","))
		sb.WriteString("|")
	}
	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}
