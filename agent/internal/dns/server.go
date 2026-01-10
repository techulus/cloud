package dns

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"

	"github.com/miekg/dns"
)

const DNSPort = 53

type Server struct {
	store       *RecordStore
	udpServer   *dns.Server
	tcpServer   *dns.Server
	listenAddr  string
	port        int
	started     atomic.Bool
	startedChan chan struct{}
	mu          sync.Mutex
}

func NewServer(port int, listenAddr string) *Server {
	return &Server{
		store:       NewRecordStore(),
		listenAddr:  listenAddr,
		port:        port,
		startedChan: make(chan struct{}),
	}
}

func (s *Server) Start(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.started.Load() {
		return nil
	}

	addr := fmt.Sprintf("%s:%d", s.listenAddr, s.port)

	handler := &dnsHandler{store: s.store}

	udpReady := make(chan struct{})
	tcpReady := make(chan struct{})
	errChan := make(chan error, 2)

	s.udpServer = &dns.Server{
		Addr:    addr,
		Net:     "udp",
		Handler: handler,
		NotifyStartedFunc: func() {
			close(udpReady)
		},
	}

	s.tcpServer = &dns.Server{
		Addr:    addr,
		Net:     "tcp",
		Handler: handler,
		NotifyStartedFunc: func() {
			close(tcpReady)
		},
	}

	go func() {
		if err := s.udpServer.ListenAndServe(); err != nil {
			select {
			case errChan <- fmt.Errorf("UDP server error: %w", err):
			default:
			}
		}
	}()

	go func() {
		if err := s.tcpServer.ListenAndServe(); err != nil {
			select {
			case errChan <- fmt.Errorf("TCP server error: %w", err):
			default:
			}
		}
	}()

	for i := 0; i < 2; i++ {
		select {
		case <-udpReady:
			udpReady = nil
		case <-tcpReady:
			tcpReady = nil
		case err := <-errChan:
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	s.started.Store(true)
	close(s.startedChan)
	log.Printf("[dns] embedded DNS server started on %s (UDP+TCP)", addr)

	return nil
}

func (s *Server) Stop(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.started.Load() {
		return nil
	}

	var errs []error
	if s.udpServer != nil {
		if err := s.udpServer.ShutdownContext(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if s.tcpServer != nil {
		if err := s.tcpServer.ShutdownContext(ctx); err != nil {
			errs = append(errs, err)
		}
	}

	s.started.Store(false)

	if len(errs) > 0 {
		return fmt.Errorf("shutdown errors: %v", errs)
	}
	log.Printf("[dns] embedded DNS server stopped")
	return nil
}

func (s *Server) UpdateRecords(records []DnsRecord) {
	s.store.Update(records)
	log.Printf("[dns] updated %d records", len(records))
}

func (s *Server) GetRecordsHash() string {
	return s.store.Hash()
}

func (s *Server) WaitReady() {
	<-s.startedChan
}
