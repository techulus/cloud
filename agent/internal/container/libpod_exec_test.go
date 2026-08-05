package container

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCopyMultiplexedOutputRejectsMalformedFrames(t *testing.T) {
	var output limitedBuffer
	if err := copyMultiplexedOutput(strings.NewReader("short"), &output); err == nil {
		t.Fatal("expected truncated frame header to fail")
	}

	var frame bytes.Buffer
	var header [8]byte
	header[0] = 9
	binary.BigEndian.PutUint32(header[4:], 1)
	frame.Write(header[:])
	frame.WriteByte('x')
	if err := copyMultiplexedOutput(&frame, &output); err == nil {
		t.Fatal("expected unknown stream to fail")
	}
}

func TestCopyMultiplexedOutputBoundsPodmanErrors(t *testing.T) {
	var frame bytes.Buffer
	var header [8]byte
	header[0] = 3
	binary.BigEndian.PutUint32(header[4:], 10_000)
	frame.Write(header[:])
	frame.WriteString(strings.Repeat("x", 10_000))

	err := copyMultiplexedOutput(&frame, &limitedBuffer{})
	if err == nil || len(err.Error()) > libpodErrorLimit+100 {
		t.Fatalf("unexpected bounded stream error: length=%d err=%v", len(err.Error()), err)
	}
}

func TestLibpodJSONRejectsOversizedResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", libpodBodyLimit+1)))
	}))
	defer server.Close()
	oldClient, oldBase := podmanHTTPClient, podmanBaseURL
	podmanHTTPClient, podmanBaseURL = server.Client(), server.URL
	t.Cleanup(func() { podmanHTTPClient, podmanBaseURL = oldClient, oldBase })

	if err := libpodJSON(http.MethodGet, "/oversized", nil, &struct{}{}); err == nil || !strings.Contains(err.Error(), "exceeds limit") {
		t.Fatalf("expected oversized response rejection, got %v", err)
	}
}

func TestExecCommandPreflightFailsBeforeCreate(t *testing.T) {
	api := installFakeExecAPI(t)
	api.preflightStatus = http.StatusNotFound
	if _, err := ExecCommand(api.containerID, api.serviceID, api.deploymentID, "true"); err == nil {
		t.Fatal("expected old API rejection")
	}
	if api.createCount != 0 {
		t.Fatalf("created %d exec sessions after failed preflight", api.createCount)
	}
}

func TestExecCommandRejectsInvalidOwnershipBeforeCreate(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*fakeExecAPI)
	}{
		{"service mismatch", func(api *fakeExecAPI) { api.inspectServiceID = "other" }},
		{"deployment mismatch", func(api *fakeExecAPI) { api.inspectDeploymentID = "other" }},
		{"unmanaged", func(api *fakeExecAPI) { api.inspectServiceID, api.inspectDeploymentID = "", "" }},
		{"stopped", func(api *fakeExecAPI) { api.running = false }},
		{"ID mismatch", func(api *fakeExecAPI) { api.inspectContainerID = "other" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := installFakeExecAPI(t)
			tt.mutate(api)
			if _, err := ExecCommand(api.containerID, api.serviceID, api.deploymentID, "true"); err == nil {
				t.Fatal("expected rejection")
			}
			if api.createCount != 0 {
				t.Fatal("exec session was created")
			}
		})
	}
}

func TestExecCommandLifecycleAndOutput(t *testing.T) {
	tests := []struct {
		name      string
		output    string
		exitCode  int
		truncated bool
	}{
		{"multiplexed output", "stdoutstderr", 0, false},
		{"nonzero exit", "bad", 7, false},
		{"exact limit", strings.Repeat("x", CommandOutputLimit), 0, false},
		{"truncated", strings.Repeat("x", CommandOutputLimit+1), 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			api := installFakeExecAPI(t)
			api.output, api.exitCode = tt.output, tt.exitCode
			result, err := ExecCommand(api.containerID, api.serviceID, api.deploymentID, "printf test")
			if err != nil {
				t.Fatal(err)
			}
			if result.ExitCode != tt.exitCode || result.Truncated != tt.truncated || result.TimedOut {
				t.Fatalf("unexpected result: %+v", result)
			}
			if result.Output != tt.output[:min(len(tt.output), CommandOutputLimit)] {
				t.Fatalf("unexpected output length/content: %d", len(result.Output))
			}
			if api.removeCount != 1 || api.lastRemoveForce {
				t.Fatalf("normal removal = count %d force %v", api.removeCount, api.lastRemoveForce)
			}
			if api.createdCommand != "printf test" {
				t.Fatalf("created command = %q", api.createdCommand)
			}
			if !api.startRequestValid {
				t.Fatal("attached exec start options were invalid")
			}
		})
	}
}

func TestExecCommandSupportsAttachedOKResponse(t *testing.T) {
	api := installFakeExecAPI(t)
	api.startStatus = http.StatusOK
	api.output = "ok response"

	result, err := ExecCommand(api.containerID, api.serviceID, api.deploymentID, "true")
	if err != nil {
		t.Fatal(err)
	}
	if result.Output != api.output || result.ExitCode != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestExecCommandTimeoutForceRemoves(t *testing.T) {
	api := installFakeExecAPI(t)
	api.hang = true
	oldTimeout := commandTimeout
	commandTimeout = 20 * time.Millisecond
	t.Cleanup(func() { commandTimeout = oldTimeout })
	result, err := ExecCommand(api.containerID, api.serviceID, api.deploymentID, "sleep")
	if err != nil {
		t.Fatal(err)
	}
	if !result.TimedOut || result.ExitCode != 124 || api.removeCount != 1 || !api.lastRemoveForce {
		t.Fatalf("unexpected timeout result=%+v remove=%d force=%v", result, api.removeCount, api.lastRemoveForce)
	}
}

func TestExecCommandForceRemoveFailureIsNotTimeout(t *testing.T) {
	api := installFakeExecAPI(t)
	api.hang = true
	api.removeStatus = http.StatusInternalServerError
	oldTimeout := commandTimeout
	commandTimeout = 20 * time.Millisecond
	t.Cleanup(func() { commandTimeout = oldTimeout })
	result, err := ExecCommand(api.containerID, api.serviceID, api.deploymentID, "sleep")
	if err == nil || result.TimedOut {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

type fakeExecAPI struct {
	server              *httptest.Server
	containerID         string
	serviceID           string
	deploymentID        string
	inspectContainerID  string
	inspectServiceID    string
	inspectDeploymentID string
	running             bool
	preflightStatus     int
	startStatus         int
	removeStatus        int
	output              string
	exitCode            int
	hang                bool
	createCount         int
	removeCount         int
	lastRemoveForce     bool
	createdCommand      string
	startRequestValid   bool
	stopOnce            sync.Once
	stop                chan struct{}
}

func installFakeExecAPI(t *testing.T) *fakeExecAPI {
	t.Helper()
	api := &fakeExecAPI{
		containerID: "container/id", serviceID: "service", deploymentID: "deployment",
		inspectContainerID: "container/id", inspectServiceID: "service", inspectDeploymentID: "deployment",
		running: true, preflightStatus: http.StatusOK, startStatus: http.StatusSwitchingProtocols, removeStatus: http.StatusOK, output: "ok", stop: make(chan struct{}),
	}
	api.server = httptest.NewServer(http.HandlerFunc(api.serveHTTP))
	address := api.server.Listener.Addr().String()
	oldClient, oldDial, oldBase := podmanHTTPClient, podmanDialContext, podmanBaseURL
	podmanDialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", address)
	}
	podmanHTTPClient = &http.Client{Transport: &http.Transport{DisableCompression: true, DialContext: podmanDialContext}}
	podmanBaseURL = "http://podman"
	t.Cleanup(func() {
		api.stopOnce.Do(func() { close(api.stop) })
		api.server.Close()
		podmanHTTPClient, podmanDialContext, podmanBaseURL = oldClient, oldDial, oldBase
	})
	return api
}

func (api *fakeExecAPI) serveHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == libpodExecBasePath+"/version":
		w.WriteHeader(api.preflightStatus)
	case strings.Contains(r.URL.Path, "/containers/") && strings.HasSuffix(r.URL.Path, "/json"):
		_ = json.NewEncoder(w).Encode(map[string]any{"Id": api.inspectContainerID, "State": map[string]any{"Running": api.running}, "Config": map[string]any{"Labels": map[string]string{"techulus.service.id": api.inspectServiceID, "techulus.deployment.id": api.inspectDeploymentID}}})
	case strings.Contains(r.URL.Path, "/containers/") && strings.HasSuffix(r.URL.Path, "/exec"):
		api.createCount++
		var request struct {
			Cmd []string `json:"Cmd"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if len(request.Cmd) == 3 {
			api.createdCommand = request.Cmd[2]
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"Id": "exec/id"})
	case strings.HasSuffix(r.URL.Path, "/start"):
		api.serveStart(w, r)
	case strings.HasSuffix(r.URL.Path, "/json"):
		_ = json.NewEncoder(w).Encode(map[string]any{"Running": false, "ExitCode": api.exitCode})
	case strings.HasSuffix(r.URL.Path, "/remove"):
		api.removeCount++
		var request struct {
			Force bool `json:"Force"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		api.lastRemoveForce = request.Force
		w.WriteHeader(api.removeStatus)
		api.stopOnce.Do(func() { close(api.stop) })
	default:
		http.NotFound(w, r)
	}
}

func (api *fakeExecAPI) serveStart(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Detach bool `json:"Detach"`
		TTY    bool `json:"Tty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid start request", http.StatusBadRequest)
		return
	}
	api.startRequestValid = !request.Detach && !request.TTY
	if !api.startRequestValid {
		http.Error(w, "invalid start options", http.StatusBadRequest)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		panic("hijacking unsupported")
	}
	conn, buffer, err := hijacker.Hijack()
	if err != nil {
		panic(err)
	}
	defer conn.Close()
	if api.startStatus == http.StatusSwitchingProtocols {
		_, _ = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
	} else {
		_, _ = buffer.WriteString("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
	}
	_ = buffer.Flush()
	if api.hang {
		<-api.stop
		return
	}
	middle := len(api.output) / 2
	for stream, payload := range []string{api.output[:middle], api.output[middle:]} {
		var header [8]byte
		header[0] = byte(stream + 1)
		binary.BigEndian.PutUint32(header[4:], uint32(len(payload)))
		_, _ = conn.Write(header[:])
		_, _ = conn.Write([]byte(payload))
	}
}
