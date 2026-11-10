package main

import (
	"os"

	"github.com/mupt-ai/dari/internal/cli"
)

// version is injected at build time via GoReleaser:
//
//	go build -ldflags "-X main.version={{.Version}}"
var version = "dev"

func main() {
	os.Exit(cli.Execute(version))
}
