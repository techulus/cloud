//go:build linux

package container

import (
	"bufio"
	"context"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func StreamLogs(ctx context.Context, opts LogsOptions, entryCh chan<- LogEntry, errCh chan<- error) {
	defer close(entryCh)
	defer close(errCh)

	args := []string{"logs", "--timestamps"}

	if opts.Follow {
		args = append(args, "-f")
	}

	if opts.Tail > 0 {
		args = append(args, "--tail", strconv.Itoa(opts.Tail))
	} else if opts.Tail != -1 {
		args = append(args, "--tail", "100")
	}

	if opts.Since != "" {
		args = append(args, "--since", opts.Since)
	}

	if opts.Until != "" {
		args = append(args, "--until", opts.Until)
	}

	args = append(args, opts.ContainerID)

	cmd := exec.CommandContext(ctx, "podman", args...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		errCh <- err
		return
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		errCh <- err
		return
	}

	if err := cmd.Start(); err != nil {
		errCh <- err
		return
	}

	done := make(chan struct{})

	var droppedCount int
	sendEntry := func(entry LogEntry) bool {
		select {
		case entryCh <- entry:
			return true
		case <-time.After(100 * time.Millisecond):
			droppedCount++
			if droppedCount%100 == 1 {
				log.Printf("[logs] Dropping log entries due to backpressure (total dropped: %d)", droppedCount)
			}
			return true
		case <-ctx.Done():
			return false
		}
	}

	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			entry := parseLogLine(scanner.Bytes(), "stdout")
			if !sendEntry(entry) {
				return
			}
		}
	}()

	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			entry := parseLogLine(scanner.Bytes(), "stderr")
			if !sendEntry(entry) {
				return
			}
		}
	}()

	go func() {
		cmd.Wait()
		close(done)
	}()

	select {
	case <-ctx.Done():
		cmd.Process.Kill()
	case <-done:
	}
}

func parseLogLine(data []byte, stream string) LogEntry {
	timestamp := time.Now()
	message := data

	if idx := strings.Index(string(data), " "); idx > 0 && idx < 40 {
		if t, err := time.Parse(time.RFC3339Nano, string(data[:idx])); err == nil {
			timestamp = t
			message = data[idx+1:]
		}
	}

	return LogEntry{
		Stream:    stream,
		Timestamp: timestamp,
		Message:   message,
	}
}
