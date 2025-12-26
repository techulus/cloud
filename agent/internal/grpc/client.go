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
	CaddyHandler func(config *pb.CaddyConfig)
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
	stopChan     chan struct{}
	stopOnce     sync.Once
	wg           sync.WaitGroup

	statusInterval    time.Duration
	heartbeatInterval time.Duration

	reconnectDelay    time.Duration
	maxReconnectDelay time.Duration
	reconnectMult     float64
}

func NewClient(address, serverID string, keyPair *crypto.KeyPair, useTLS bool) *Client {
	return &Client{
		address:           address,
		serverID:          serverID,
		keyPair:           keyPair,
		useTLS:            useTLS,
		stopChan:          make(chan struct{}),
		statusInterval:    10 * time.Second,
		heartbeatInterval: 30 * time.Second,
		reconnectDelay:    1 * time.Second,
		maxReconnectDelay: 5 * time.Minute,
		reconnectMult:     2.0,
	}
}

func (c *Client) SetWorkHandler(handler WorkHandler) {
	c.workHandler = handler
}

func (c *Client) SetCaddyHandler(handler CaddyHandler) {
	c.caddyHandler = handler
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

func (c *Client) signProto(msg proto.Message) (timestamp, signature string, err error) {
	payloadBytes, err := proto.Marshal(msg)
	if err != nil {
		return "", "", fmt.Errorf("failed to marshal proto: %w", err)
	}

	timestamp = strconv.FormatInt(time.Now().UnixMilli(), 10)
	message := append([]byte(timestamp+":"), payloadBytes...)
	signature = c.keyPair.Sign(message)

	return timestamp, signature, nil
}

type StatusData struct {
	Resources   *pb.Resources
	PublicIP    string
	Containers  []*pb.ContainerInfo
	ProxyRoutes []*pb.ProxyRouteInfo
}

func (c *Client) SendStatusUpdate(status *StatusData) error {
	update := &pb.StatusUpdate{
		Resources:   status.Resources,
		PublicIp:    status.PublicIP,
		Containers:  status.Containers,
		ProxyRoutes: status.ProxyRoutes,
	}

	timestamp, signature, err := c.signProto(update)
	if err != nil {
		return err
	}

	msg := &pb.AgentMessage{
		ServerId:  c.serverID,
		Timestamp: timestamp,
		Signature: signature,
		Payload:   &pb.AgentMessage_StatusUpdate{StatusUpdate: update},
	}

	log.Printf("[grpc:send] type=StatusUpdate containers=%d", len(status.Containers))
	return c.stream.Send(msg)
}

func (c *Client) SendWorkComplete(workID, workStatus, logs string) error {
	complete := &pb.WorkComplete{
		WorkId: workID,
		Status: workStatus,
		Logs:   logs,
	}

	timestamp, signature, err := c.signProto(complete)
	if err != nil {
		return err
	}

	msg := &pb.AgentMessage{
		ServerId:  c.serverID,
		Timestamp: timestamp,
		Signature: signature,
		Payload:   &pb.AgentMessage_WorkComplete{WorkComplete: complete},
	}

	log.Printf("[grpc:send] type=WorkComplete work_id=%s status=%s", workID, workStatus)
	return c.stream.Send(msg)
}

func (c *Client) SendHeartbeat() error {
	heartbeat := &pb.Heartbeat{
		Timestamp: time.Now().UnixMilli(),
	}

	timestamp, signature, err := c.signProto(heartbeat)
	if err != nil {
		return err
	}

	msg := &pb.AgentMessage{
		ServerId:  c.serverID,
		Timestamp: timestamp,
		Signature: signature,
		Payload:   &pb.AgentMessage_Heartbeat{Heartbeat: heartbeat},
	}

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

func (c *Client) handleMessage(msg *pb.ControlPlaneMessage) {
	switch payload := msg.Payload.(type) {
	case *pb.ControlPlaneMessage_Connected:
		c.sessionID = payload.Connected.SessionId
		log.Printf("[grpc:recv] type=Connected session=%s", c.sessionID)

	case *pb.ControlPlaneMessage_Work:
		log.Printf("[grpc:recv] type=WorkItem work_id=%s work_type=%s", payload.Work.Id, payload.Work.Type)
		if c.workHandler != nil {
			go func() {
				status, logs := c.workHandler(payload.Work)
				if err := c.SendWorkComplete(payload.Work.Id, status, logs); err != nil {
					log.Printf("Failed to send work complete: %v", err)
				}
			}()
		}

	case *pb.ControlPlaneMessage_Ack:
		log.Printf("[grpc:recv] type=Ack message_id=%s", payload.Ack.MessageId)

	case *pb.ControlPlaneMessage_Error:
		log.Printf("[grpc:recv] type=Error code=%d message=%s fatal=%v",
			payload.Error.Code, payload.Error.Message, payload.Error.Fatal)
		if payload.Error.Fatal {
			c.stopOnce.Do(func() { close(c.stopChan) })
		}

	case *pb.ControlPlaneMessage_CaddyConfig:
		log.Printf("[grpc:recv] type=CaddyConfig routes=%d", len(payload.CaddyConfig.Routes))
		if c.caddyHandler != nil {
			go c.caddyHandler(payload.CaddyConfig)
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

		if err := c.Connect(ctx); err != nil {
			log.Printf("Connection failed: %v, retrying in %v", err, delay)
			time.Sleep(delay)
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

		receiverCtx, cancelReceiver := context.WithCancel(ctx)
		go c.RunReceiver(receiverCtx)
		c.RunSender(ctx, func() *StatusData { return getStatus(false) })

		cancelReceiver()
		c.conn.Close()

		log.Println("Connection lost, reconnecting...")
		time.Sleep(delay)
	}
}
