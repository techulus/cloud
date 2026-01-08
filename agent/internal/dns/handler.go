package dns

import (
	"github.com/miekg/dns"
)

const defaultTTL = 30

type dnsHandler struct {
	store *RecordStore
}

func (h *dnsHandler) ServeDNS(w dns.ResponseWriter, r *dns.Msg) {
	m := new(dns.Msg)
	m.SetReply(r)
	m.Authoritative = true

	for _, q := range r.Question {
		switch q.Qtype {
		case dns.TypeA:
			h.handleA(m, q)
		case dns.TypeAAAA:
			h.handleAAAA(m, q)
		default:
			m.Rcode = dns.RcodeNotImplemented
		}
	}

	w.WriteMsg(m)
}

func (h *dnsHandler) handleA(m *dns.Msg, q dns.Question) {
	ips := h.store.Lookup(q.Name)

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

	if len(m.Answer) == 0 {
		m.Rcode = dns.RcodeNameError
	}
}

func (h *dnsHandler) handleAAAA(m *dns.Msg, q dns.Question) {
	ips := h.store.Lookup(q.Name)

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

	if len(m.Answer) == 0 {
		m.Rcode = dns.RcodeNameError
	}
}
