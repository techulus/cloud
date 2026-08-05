package container

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	libpodExecBasePath = "/v4.8.0/libpod"
	libpodBodyLimit    = 1024 * 1024
	libpodErrorLimit   = 4 * 1024
	libpodRequestTime  = 10 * time.Second
)

type execContainerInspect struct {
	ID    string `json:"Id"`
	State struct {
		Running bool `json:"Running"`
	} `json:"State"`
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
}

type execCreateResponse struct {
	ID string `json:"Id"`
}

type execInspectResponse struct {
	Running  bool `json:"Running"`
	ExitCode int  `json:"ExitCode"`
}

type attachedExecStream struct {
	io.Reader
	closers []io.Closer
}

func (s *attachedExecStream) Close() error {
	var closeErrors []error
	for _, closer := range s.closers {
		if err := closer.Close(); err != nil {
			closeErrors = append(closeErrors, err)
		}
	}
	return errors.Join(closeErrors...)
}

func ExecCommand(containerID, serviceID, deploymentID, command string) (CommandResult, error) {
	if err := execPreflight(); err != nil {
		return CommandResult{}, err
	}
	if err := verifyExecContainer(containerID, serviceID, deploymentID); err != nil {
		return CommandResult{}, err
	}

	execID, err := createExec(containerID, command)
	if err != nil {
		return CommandResult{}, err
	}

	startCtx, cancelStart := context.WithTimeout(context.Background(), libpodRequestTime)
	stream, err := startAttachedExec(startCtx, execID)
	cancelStart()
	if err != nil {
		cleanupErr := removeExecSession(execID, true)
		if cleanupErr != nil {
			return CommandResult{}, fmt.Errorf("failed to start exec session: %w; cleanup failed: %v", err, cleanupErr)
		}
		return CommandResult{}, fmt.Errorf("failed to start exec session: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()

	var output limitedBuffer
	streamDone := make(chan error, 1)
	go func() {
		streamDone <- copyMultiplexedOutput(stream, &output)
	}()

	select {
	case streamErr := <-streamDone:
		_ = stream.Close()
		if streamErr != nil {
			if cleanupErr := removeExecSession(execID, true); cleanupErr != nil {
				return commandResult(&output), fmt.Errorf("failed to read exec output: %w; cleanup failed: %v", streamErr, cleanupErr)
			}
			return commandResult(&output), fmt.Errorf("failed to read exec output: %w", streamErr)
		}
		inspect, err := inspectExecSession(execID)
		if err != nil {
			_ = removeExecSession(execID, true)
			return commandResult(&output), err
		}
		if inspect.Running {
			_ = removeExecSession(execID, true)
			return commandResult(&output), fmt.Errorf("exec session remained running after attached stream ended")
		}
		if err := removeExecSession(execID, false); err != nil {
			return commandResult(&output), err
		}
		result := commandResult(&output)
		result.ExitCode = inspect.ExitCode
		return result, nil
	case <-ctx.Done():
		_ = stream.Close()
		if err := removeExecSession(execID, true); err != nil {
			return commandResult(&output), fmt.Errorf("command deadline exceeded but exec session cleanup failed: %w", err)
		}
		select {
		case <-streamDone:
		case <-time.After(time.Second):
		}
		result := commandResult(&output)
		result.ExitCode = 124
		result.TimedOut = true
		return result, nil
	}
}

func commandResult(output *limitedBuffer) CommandResult {
	text, truncated := output.snapshot()
	text = strings.ToValidUTF8(text, "�")
	if len(text) > CommandOutputLimit {
		text = text[:CommandOutputLimit]
		for !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
		truncated = true
	}
	return CommandResult{Output: text, Truncated: truncated}
}

func execPreflight() error {
	ctx, cancel := context.WithTimeout(context.Background(), libpodRequestTime)
	defer cancel()
	resp, err := libpodRequest(ctx, http.MethodGet, libpodExecBasePath+"/version", nil)
	if err != nil {
		return fmt.Errorf("podman 4.8 exec API preflight failed: %w", err)
	}
	defer resp.Body.Close()
	if err := requireSuccess(resp, "Podman 4.8 exec API preflight"); err != nil {
		return err
	}
	_, err = io.Copy(io.Discard, io.LimitReader(resp.Body, libpodBodyLimit+1))
	return err
}

func verifyExecContainer(containerID, serviceID, deploymentID string) error {
	var inspect execContainerInspect
	if err := libpodJSON(http.MethodGet, libpodExecBasePath+"/containers/"+url.PathEscape(containerID)+"/json", nil, &inspect); err != nil {
		return fmt.Errorf("failed to inspect command container: %w", err)
	}
	if inspect.ID != containerID {
		return fmt.Errorf("inspected container ID does not match command target")
	}
	if !inspect.State.Running {
		return fmt.Errorf("container is not running")
	}
	if inspect.Config.Labels["techulus.service.id"] != serviceID || inspect.Config.Labels["techulus.deployment.id"] != deploymentID {
		return fmt.Errorf("container ownership does not match command target")
	}
	return nil
}

func createExec(containerID, command string) (string, error) {
	body := struct {
		AttachStdout bool     `json:"AttachStdout"`
		AttachStderr bool     `json:"AttachStderr"`
		TTY          bool     `json:"Tty"`
		Cmd          []string `json:"Cmd"`
	}{true, true, false, []string{"/bin/sh", "-c", command}}
	var created execCreateResponse
	if err := libpodJSON(http.MethodPost, libpodExecBasePath+"/containers/"+url.PathEscape(containerID)+"/exec", body, &created); err != nil {
		return "", fmt.Errorf("failed to create exec session: %w", err)
	}
	if created.ID == "" {
		return "", fmt.Errorf("failed to create exec session: Podman returned an empty ID")
	}
	return created.ID, nil
}

func inspectExecSession(execID string) (execInspectResponse, error) {
	var inspect execInspectResponse
	err := libpodJSON(http.MethodGet, libpodExecBasePath+"/exec/"+url.PathEscape(execID)+"/json", nil, &inspect)
	if err != nil {
		return inspect, fmt.Errorf("failed to inspect exec session: %w", err)
	}
	return inspect, nil
}

func removeExecSession(execID string, force bool) error {
	body := struct {
		Force bool `json:"Force"`
	}{force}
	if err := libpodJSON(http.MethodPost, libpodExecBasePath+"/exec/"+url.PathEscape(execID)+"/remove", body, nil); err != nil {
		return fmt.Errorf("failed to remove exec session: %w", err)
	}
	return nil
}

func libpodJSON(method, path string, requestBody, responseBody any) error {
	ctx, cancel := context.WithTimeout(context.Background(), libpodRequestTime)
	defer cancel()
	var body io.Reader
	if requestBody != nil {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	resp, err := libpodRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := requireSuccess(resp, "Podman request"); err != nil {
		return err
	}
	if responseBody == nil {
		data, err := io.ReadAll(io.LimitReader(resp.Body, libpodBodyLimit+1))
		if err != nil {
			return err
		}
		if len(data) > libpodBodyLimit {
			return fmt.Errorf("podman response exceeds limit")
		}
		return nil
	}
	limited := io.LimitReader(resp.Body, libpodBodyLimit+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return err
	}
	if len(data) > libpodBodyLimit {
		return fmt.Errorf("podman response exceeds limit")
	}
	if err := json.Unmarshal(data, responseBody); err != nil {
		return fmt.Errorf("invalid Podman response: %w", err)
	}
	return nil
}

func libpodRequest(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, podmanBaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return podmanHTTPClient.Do(req)
}

func requireSuccess(resp *http.Response, operation string) error {
	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		return nil
	}
	message, _ := io.ReadAll(io.LimitReader(resp.Body, libpodErrorLimit))
	return fmt.Errorf("%s failed: Podman returned %s: %s", operation, resp.Status, strings.TrimSpace(string(message)))
}

func startAttachedExec(ctx context.Context, execID string) (io.ReadCloser, error) {
	conn, err := podmanDialContext(ctx, "unix", "podman")
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			_ = conn.Close()
		}
	}()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	body := strings.NewReader(`{"Detach":false,"Tty":false}`)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, podmanBaseURL+libpodExecBasePath+"/exec/"+url.PathEscape(execID)+"/start", body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "tcp")
	if err := req.Write(conn); err != nil {
		return nil, err
	}
	buffered := bufio.NewReader(conn)
	resp, err := http.ReadResponse(buffered, req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols && resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return nil, requireSuccess(resp, "start attached exec session")
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		_ = resp.Body.Close()
		return nil, err
	}
	success = true
	if resp.StatusCode == http.StatusSwitchingProtocols {
		return &attachedExecStream{Reader: buffered, closers: []io.Closer{conn}}, nil
	}
	return &attachedExecStream{
		Reader:  resp.Body,
		closers: []io.Closer{resp.Body, conn},
	}, nil
}

func copyMultiplexedOutput(reader io.Reader, output io.Writer) error {
	var header [8]byte
	buffer := make([]byte, 32*1024)
	for {
		_, err := io.ReadFull(reader, header[:])
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("invalid multiplexed frame header: %w", err)
		}
		if header[1] != 0 || header[2] != 0 || header[3] != 0 {
			return fmt.Errorf("invalid multiplexed frame header")
		}
		remaining := uint64(binary.BigEndian.Uint32(header[4:]))
		if header[0] == 3 {
			messageLength := min(remaining, uint64(libpodErrorLimit))
			message := make([]byte, messageLength)
			if _, err := io.ReadFull(reader, message); err != nil {
				return fmt.Errorf("invalid multiplexed error frame: %w", err)
			}
			if _, err := io.CopyN(io.Discard, reader, int64(remaining-messageLength)); err != nil {
				return fmt.Errorf("invalid multiplexed error frame: %w", err)
			}
			return fmt.Errorf("podman exec stream failed: %s", strings.TrimSpace(string(message)))
		}
		if header[0] != 0 && header[0] != 1 && header[0] != 2 {
			return fmt.Errorf("invalid multiplexed stream %d", header[0])
		}
		for remaining > 0 {
			chunk := uint64(len(buffer))
			if remaining < chunk {
				chunk = remaining
			}
			if _, err := io.ReadFull(reader, buffer[:int(chunk)]); err != nil {
				return fmt.Errorf("invalid multiplexed frame payload: %w", err)
			}
			if _, err := output.Write(buffer[:int(chunk)]); err != nil {
				return err
			}
			remaining -= chunk
		}
	}
}
