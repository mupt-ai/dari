//go:build !unix

package gateway

import "os/exec"

func detach(*exec.Cmd) {}
