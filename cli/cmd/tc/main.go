package main

import (
	"fmt"
	"os"

	"techulus/cloud-cli/internal/cli"
)

var version = "dev"

func main() {
	if err := cli.Execute(version, os.Stdin, os.Stdout, os.Stderr); err != nil {
		if !cli.IsHandledError(err) {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
