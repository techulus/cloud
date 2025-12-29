package grpc

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	"techulus/cloud-agent/internal/crypto"
	pb "techulus/cloud-agent/internal/proto"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/protobuf/proto"
)

type (
	WorkHandler  func(work *pb.WorkItem) (status string, logs string)
	CaddyHandler func(config *pb.CaddyConfig) (bool, error)
	DnsHandler   func(config *pb.DnsConfig) (bool, error)
)

type Client struct {
	address   string
	serverID  string
	keyPair   *crypto.KeyPair
	conn      *grpc.ClientConn
	stream    pb.AgentService_ConnectClient
	sessionID string
	useTLS    bool

	workHandler  WorkHandler
	caddyHandler CaddyHandler
	dnsHandler   DnsHandler
	logMonitor   *ContainerLogMonitor
	logMonitorCancel context.CancelFunc
	stopChan         chan struct{}
	stopOnce         sync.Once
	wg               sync.WaitGroup

	statusInterval    time.Duration
	heartbeatInterval time.Duration

	reconnectDelay    time.Duration
	maxReconnectDelay time.Duration
	reconnectMult     float64

	outgoingSequence uint64
	lastServerSeq    uint64
	seqMu            sync.Mutex
}

func NewClient(address, serverID string, keyPair *crypto.KeyPair, useTLS bool) *Client {
	c := &Client{
		address:           address,
		serverID:          serverID,
		keyPair:           keyPair,
		useTLS:            useTLS,
		stopChan:          make(chan struct{}),
		statusInterval:    30 * time.Second,
		heartbeatInterval: 30 * time.Second,
		reconnectDelay:    1 * time.Second,
		maxReconnectDelay: 5 * time.Minute,
		reconnectMult:     2.0,
	}
	c.logMonitor = NewContainerLogMonitor(c.SendLogEntry)
	return c
}

func (c *Client) SetWorkHandler(handler WorkHandler) {
	c.workHandler = handler
}

func (c *Client) SetCaddyHandler(handler CaddyHandler) {
	c.caddyHandler = handler
}

func (c *Client) SetDnsHandler(handler DnsHandler) {
	c.dnsHandler = handler
}

func (c *Client) nextSequence() uint64 {
	c.seqMu.Lock()
	defer c.seqMu.Unlock()
	c.outgoingSequence++
	return c.outgoingSequence
}

func (c *Client) resetSequences() {
	c.seqMu.Lock()
	defer c.seqMu.Unlock()
	c.outgoingSequence = 0
	c.lastServerSeq = 0
}

func (c *Client) validateServerSequence(seq uint64) bool {
	c.seqMu.Lock()
	defer c.seqMu.Unlock()
	if seq <= c.lastServerSeq {
		return false
	}
	c.lastServerSeq = seq
	return true
}

func (c *Client) Connect(ctx context.Context) error {
	var creds credentials.TransportCredentials
	if c.useTLS {
		creds = credentials.NewTLS(&tls.Config{})
	} else {
		creds = insecure.NewCredentials()
	}

	opts := []grpc.DialOption{
		grpc.WithTransportCredentials(creds),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                10 * time.Second,
			Timeout:             5 * time.Second,
			PermitWithoutStream: true,
		}),
	}

	conn, err := grpc.NewClient(c.address, opts...)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	c.conn = conn

	client := pb.NewAgentServiceClient(conn)
	stream, err := client.Connect(ctx)
	if err != nil {
		conn.Close()
		return fmt.Errorf("failed to start stream: %w", err)
	}
	c.stream = stream

	return nil
}

func (c *Client) signProtoWithSeq(msg proto.Message, seq uint64) (timestamp, signature string, err error) {
	payloadBytes, err := proto.Marshal(msg)
	if err != nil {
		return "", "", fmt.Errorf("failed to marshal proto: %w", err)
	}

	timestamp = strconv.FormatInt(time.Now().UnixMilli(), 10)
	message := append([]byte(timestamp+":"), payloadBytes...)
	signature = c.keyPair.Sign(message)

	return timestamp, signature, nil
}

type ContainerHealthData struct {
	ContainerID  string
	HealthStatus string
}

type StatusData struct {
	Resources       *pb.Resources
	PublicIP        string
	ContainerHealth []ContainerHealthData
}

func (c *Client) SendStatusUpdate(status *StatusData) error {
	containerHealth := make([]*pb.ContainerHealth, len(status.ContainerHealth))
	for i, ch := range status.ContainerHealth {
		containerHealth[i] = &pb.ContainerHealth{
			ContainerId:  ch.ContainerID,
			HealthStatus: ch.HealthStatus,
		}
	}

	update := &pb.StatusUpdate{
		Resources:       status.Resources,
		PublicIp:        status.PublicIP,
		ContainerHealth: containerHealth,
	}

	seq := c.nextSequence()
	timestamp, signature, err := c.signProtoWithSeq(update, seq)
	if err != nil {
		return err
	}

	msg := &pb.AgentMessage{
		ServerId:  c.serverID,
		Timestamp: timestamp,
		Signature: signature,
		Sequence:  seq,
		Payload:   &pb.AgentMessage_StatusUpdate{StatusUpdate: update},
	}

	log.Printf("[grpc:send] type=StatusUpdate seq=%d", seq)
	return c.stream.Send(msg)
}

func (c *Client) SendWorkComplete(workID, workStatus, logs string) error {
	complete := &pb.WorkComplete{
		WorkId: workID,
		Status: workStatus,
		Logs:   logs,
	}

	seq := c.nextSequence()
	timestamp, signature, err := c.signProtoWithSeq(complete, seq)
	if err != nil {
		return err
	}

	msg := &pb.AgentMessage{
		ServerId:  c.serverID,
		Timestamp: timestamp,
		Signature: signature,
		Sequence:  seq,
		Payload:   &pb.AgentMessage_WorkComplete{WorkComplete: complete},
	}

	log.Printf("[grpc:send] type=WorkComplete work_id=%s status=%s seq=%d", workID, workStatus, seq)
	return c.stream.Send(msg)
}

func (c *Client) SendHeartbeat() error {
	heartbeat := &pb.Heartbeat{
		Timestamp: time.Now().UnixMilli(),
	}

	seq := c.nextSequence()
	timestamp, signature, err := c.signProtoWithSeq(heartbeat, seq)
	if err != nil {
		return err
	}

	msg := &pb.AgentMessage{
		ServerId:  c.serverID,
		Timestamp: timestamp,
		Signature: signature,
		Sequence:  seq,
		Payload:   &pb.AgentMessage_Heartbeat{Heartbeat: heartbeat},
	}

	return c.stream.Send(msg)
}

func (c *Client) SendLogEntry(entry *pb.LogEntry) error {
	seq := c.nextSequence()
	timestamp, signature, err := c.signProtoWithSeq(entry, seq)
	if err != nil {
		return err
	}

	msg := &pb.AgentMessage{
		ServerId:  c.serverID,
		Timestamp: timestamp,
		Signature: signature,
		Sequence:  seq,
		Payload:   &pb.AgentMessage_LogEntry{LogEntry: entry},
	}

	return c.stream.Send(msg)
}

func (c *Client) SendBuildLog(deploymentID string, stream string, message string) error {
	streamType := pb.LogStreamType_LOG_STREAM_TYPE_STDOUT
	if stream == "stderr" {
		streamType = pb.LogStreamType_LOG_STREAM_TYPE_STDERR
	}

	return c.SendLogEntry(&pb.LogEntry{
		StreamType:   streamType,
		Timestamp:    time.Now().UnixMilli(),
		Message:      []byte(message),
		DeploymentId: deploymentID,
	})
}

func (c *Client) SendConfigAck(configType string, success bool, errMsg string) error {
	ack := &pb.ConfigAck{
		ConfigType: configType,
		Success:    success,
		Error:      errMsg,
	}

	seq := c.nextSequence()
	timestamp, signature, err := c.signProtoWithSeq(ack, seq)
	if err != nil {
		return err
	}

	msg := &pb.AgentMessage{
		ServerId:  c.serverID,
		Timestamp: timestamp,
		Signature: signature,
		Sequence:  seq,
		Payload:   &pb.AgentMessage_ConfigAck{ConfigAck: ack},
	}

	log.Printf("[grpc:send] type=ConfigAck config_type=%s success=%v seq=%d", configType, success, seq)
	return c.stream.Send(msg)
}

func (c *Client) RunReceiver(ctx context.Context) {
	c.wg.Add(1)
	defer c.wg.Done()

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopChan:
			return
		default:
			msg, err := c.stream.Recv()
			if err != nil {
				log.Printf("Stream receive error: %v", err)
				return
			}

			c.handleMessage(msg)
		}
	}
}

func (c *Client) validateServerMessage(msg *pb.ControlPlaneMessage) bool {
	if !c.validateServerSequence(msg.Sequence) {
		log.Printf("[grpc:verify] replay detected: seq=%d", msg.Sequence)
		return false
	}
	return true
}

func (c *Client) handleMessage(msg *pb.ControlPlaneMessage) {
	if !c.validateServerMessage(msg) {
		log.Printf("[grpc:recv] REJECTED - replay detected seq=%d", msg.Sequence)
		c.stopOnce.Do(func() { close(c.stopChan) })
		return
	}

	switch payload := msg.Payload.(type) {
	case *pb.ControlPlaneMessage_Connected:
		c.sessionID = payload.Connected.SessionId
		log.Printf("[grpc:recv] type=Connected session=%s seq=%d", c.sessionID, msg.Sequence)

	case *pb.ControlPlaneMessage_Work:
		log.Printf("[grpc:recv] type=WorkItem work_id=%s work_type=%s seq=%d", payload.Work.Id, payload.Work.Type, msg.Sequence)
		if c.workHandler != nil {
			go func() {
				status, logs := c.workHandler(payload.Work)
				if err := c.SendWorkComplete(payload.Work.Id, status, logs); err != nil {
					log.Printf("Failed to send work complete: %v", err)
				}
			}()
		}

	case *pb.ControlPlaneMessage_Ack:
		log.Printf("[grpc:recv] type=Ack message_id=%s seq=%d", payload.Ack.MessageId, msg.Sequence)

	case *pb.ControlPlaneMessage_Error:
		log.Printf("[grpc:recv] type=Error code=%d message=%s fatal=%v seq=%d",
			payload.Error.Code, payload.Error.Message, payload.Error.Fatal, msg.Sequence)
		if payload.Error.Fatal {
			c.stopOnce.Do(func() { close(c.stopChan) })
		}

	case *pb.ControlPlaneMessage_CaddyConfig:
		log.Printf("[grpc:recv] type=CaddyConfig routes=%d seq=%d", len(payload.CaddyConfig.Routes), msg.Sequence)
		if c.caddyHandler != nil {
			go func() {
				success, err := c.caddyHandler(payload.CaddyConfig)
				errMsg := ""
				if err != nil {
					errMsg = err.Error()
					log.Printf("[caddy:error] config update failed: %v", err)
				}
				if sendErr := c.SendConfigAck("caddy", success, errMsg); sendErr != nil {
					log.Printf("Failed to send caddy config ack: %v", sendErr)
				}
			}()
		}

	case *pb.ControlPlaneMessage_DnsConfig:
		log.Printf("[grpc:recv] type=DnsConfig records=%d seq=%d", len(payload.DnsConfig.Records), msg.Sequence)
		if c.dnsHandler != nil {
			go func() {
				success, err := c.dnsHandler(payload.DnsConfig)
				errMsg := ""
				if err != nil {
					errMsg = err.Error()
					log.Printf("[dns:error] config update failed: %v", err)
				}
				if sendErr := c.SendConfigAck("dns", success, errMsg); sendErr != nil {
					log.Printf("Failed to send dns config ack: %v", sendErr)
				}
			}()
		}
	}
}

func (c *Client) RunSender(ctx context.Context, getStatus func() *StatusData) {
	c.wg.Add(1)
	defer c.wg.Done()

	statusTicker := time.NewTicker(c.statusInterval)
	heartbeatTicker := time.NewTicker(c.heartbeatInterval)
	defer statusTicker.Stop()
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopChan:
			return
		case <-statusTicker.C:
			status := getStatus()
			if err := c.SendStatusUpdate(status); err != nil {
				log.Printf("Failed to send status update: %v", err)
				return
			}
		case <-heartbeatTicker.C:
			if err := c.SendHeartbeat(); err != nil {
				log.Printf("Failed to send heartbeat: %v", err)
				return
			}
		}
	}
}

func (c *Client) Close() error {
	c.stopOnce.Do(func() { close(c.stopChan) })
	c.wg.Wait()

	if c.stream != nil {
		c.stream.CloseSend()
	}

	if c.conn != nil {
		return c.conn.Close()
	}

	return nil
}

func (c *Client) RunWithReconnect(ctx context.Context, getStatus func(includeResources bool) *StatusData) {
	delay := c.reconnectDelay

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		c.stopChan = make(chan struct{})
		c.stopOnce = sync.Once{}
		c.resetSequences()

		if err := c.Connect(ctx); err != nil {
			log.Printf("Connection failed: %v, retrying in %v", err, delay)
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			delay = min(time.Duration(float64(delay)*c.reconnectMult), c.maxReconnectDelay)
			continue
		}

		status := getStatus(true)
		if err := c.SendStatusUpdate(status); err != nil {
			log.Printf("Initial status update failed: %v", err)
			c.conn.Close()
			continue
		}

		delay = c.reconnectDelay

		logMonitorCtx, logMonitorCancel := context.WithCancel(ctx)
		c.logMonitorCancel = logMonitorCancel
		go c.logMonitor.Run(logMonitorCtx)

		receiverCtx, cancelReceiver := context.WithCancel(ctx)
		go c.RunReceiver(receiverCtx)
		c.RunSender(ctx, func() *StatusData { return getStatus(false) })

		logMonitorCancel()
		cancelReceiver()
		c.conn.Close()

		log.Println("Connection lost, reconnecting...")
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}
