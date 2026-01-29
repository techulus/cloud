package dns

import (
	"time"

	"github.com/miekg/dns"
)

const defaultTTL = 30

var upstreamServers = []string{
	"8.8.8.8:53",
	"1.1.1.1:53",
}

type dnsHandler struct {
	store  *RecordStore
	client *dns.Client
}

func newDNSHandler(store *RecordStore) *dnsHandler {
	return &dnsHandler{
		store: store,
		client: &dns.Client{
			Net:     "udp",
			Timeout: 5 * time.Second,
		},
	}
}

func (h *dnsHandler) ServeDNS(w dns.ResponseWriter, r *dns.Msg) {
	m := new(dns.Msg)
	m.SetReply(r)
	m.Authoritative = true

	for _, q := range r.Question {
		switch q.Qtype {
		case dns.TypeA:
			if !h.handleA(m, q) {
				h.forwardQuery(w, r)
				return
			}
		case dns.TypeAAAA:
			if !h.handleAAAA(m, q) {
				h.forwardQuery(w, r)
				return
			}
		default:
			h.forwardQuery(w, r)
			return
		}
	}

	w.WriteMsg(m)
}

func (h *dnsHandler) handleA(m *dns.Msg, q dns.Question) bool {
	ips := h.store.Lookup(q.Name)

	if ips == nil {
		return false
	}

	for _, ip := range ips {
		if ip4 := ip.To4(); ip4 != nil {
			rr := &dns.A{
				Hdr: dns.RR_Header{
					Name:   q.Name,
					Rrtype: dns.TypeA,
					Class:  dns.ClassINET,
					Ttl:    defaultTTL,
				},
				A: ip4,
			}
			m.Answer = append(m.Answer, rr)
		}
	}
	return true
}

func (h *dnsHandler) handleAAAA(m *dns.Msg, q dns.Question) bool {
	ips := h.store.Lookup(q.Name)

	if ips == nil {
		return false
	}

	for _, ip := range ips {
		if ip.To4() == nil && ip.To16() != nil {
			rr := &dns.AAAA{
				Hdr: dns.RR_Header{
					Name:   q.Name,
					Rrtype: dns.TypeAAAA,
					Class:  dns.ClassINET,
					Ttl:    defaultTTL,
				},
				AAAA: ip,
			}
			m.Answer = append(m.Answer, rr)
		}
	}
	return true
}

func (h *dnsHandler) forwardQuery(w dns.ResponseWriter, r *dns.Msg) {
	for _, server := range upstreamServers {
		resp, _, err := h.client.Exchange(r, server)
		if err != nil {
			continue
		}
		resp.Id = r.Id
		w.WriteMsg(resp)
		return
	}

	m := new(dns.Msg)
	m.SetReply(r)
	m.Rcode = dns.RcodeServerFailure
	w.WriteMsg(m)
}
