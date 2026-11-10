//go:build !darwin && !linux

package cli

// discardAgentInput keeps typed-ahead keys where the terminal offers no
// input flush.
func discardAgentInput(int) {}
