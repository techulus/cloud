package main

import (
	"agent/pkg/cloud"
	"fmt"
	"os"
	"os/signal"
	"time"
)

func main() {
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt)

	ticker := time.NewTicker(300 * time.Second)
	defer ticker.Stop()

	if err := cloud.SendStatusUpdate(); err != nil {
		fmt.Printf("Failed to send status update: %v\n", err)
	}

	for {
		select {
		case <-shutdown:
			fmt.Printf("Shutting down agent...")
			return
		case <-ticker.C:
			if err := cloud.SendStatusUpdate(); err != nil {
				fmt.Printf("Failed to send status update: %v\n", err)
			}
		}
	}
}
