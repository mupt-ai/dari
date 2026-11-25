package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"github.com/spf13/cobra"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// The standalone engine owns the model catalog, weights, and protocol. The Go
// CLI only forwards local commands; it never uses a hosted router or Ollama.
func init() {
	commandRegistrars = append(commandRegistrars, func(root *cobra.Command, _ *globalFlags) {
		inference := &cobra.Command{Use: "inference <model>", Short: "Serve a local model with Dari's optimized engine.", Args: cobra.ExactArgs(1)}
		configureServe(inference)
		root.AddCommand(inference)
		for _, parent := range []*cobra.Command{root, inference} {
			serve := &cobra.Command{Use: "serve", Short: "Start the local Dari inference server.", Args: cobra.NoArgs}
			configureServe(serve)
			run := &cobra.Command{Use: "run <model>", Short: "Start the local API for an installed model.", Args: cobra.ExactArgs(1)}
			configureServe(run)
			parent.AddCommand(serve, run)
			for _, spec := range []struct {
				use, description string
				args             cobra.PositionalArgs
			}{
				{"pull <model>", "Explicitly download a supported model for Dari.", cobra.ExactArgs(1)},
				{"list", "List installed Dari models without downloading anything.", cobra.NoArgs},
				{"show <model>", "Show the local engine, checkpoint and model context limit.", cobra.ExactArgs(1)},
			} {
				cmd := &cobra.Command{Use: spec.use, Short: spec.description, Args: spec.args, RunE: func(cmd *cobra.Command, args []string) error {
					return inferenceExec(cmd, append([]string{cmd.Name()}, args...)...)
				}}
				if cmd.Name() == "pull" && parent == inference {
					cmd.Aliases = []string{"install"}
				}
				parent.AddCommand(cmd)
			}
		}
	})
}

func configureServe(cmd *cobra.Command) {
	port := cmd.Flags().Int("port", 8081, "Local Dari HTTP port")
	window := cmd.Flags().Int("context-window", 0, "Combined input and output token budget (default: $DARI_CONTEXT_LENGTH or 50000)")
	snapshot := cmd.Flags().String("snapshot", "", "Use an existing local checkpoint")
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		argv := []string{"serve"}
		if len(args) != 0 {
			argv = []string{"run", args[0]}
		}
		argv = append(argv, "--port", strconv.Itoa(*port))
		if cmd.Flags().Changed("context-window") {
			argv = append(argv, "--context-window", strconv.Itoa(*window))
		}
		if *snapshot != "" {
			argv = append(argv, "--snapshot", *snapshot)
		}
		return inferenceExec(cmd, argv...)
	}
}

func inferenceExec(cmd *cobra.Command, args ...string) error {
	engine := "dari-inference"
	if source := os.Getenv("DARI_INFERENCE_SOURCE"); source != "" {
		path, err := filepath.Abs(source)
		if err != nil {
			return err
		}
		engine = filepath.Join(path, "dari-inference")
	} else if _, err := exec.LookPath(engine); err != nil {
		return fmt.Errorf("Dari inference runtime not found: set DARI_INFERENCE_SOURCE to the dari-inference checkout, then run dari pull <model>")
	}
	child := exec.CommandContext(cmd.Context(), engine, args...)
	// A foreground server owns the CLI PID, so a supervisor stopping `dari`
	// also releases the listener and model memory. The engine launcher execs Python.
	if agents.CanReplaceProcess && (args[0] == "run" || args[0] == "serve") {
		if child.Err != nil {
			return child.Err
		}
		if err := agents.ReplaceProcess(child.Path, child.Args, os.Environ()); err != nil {
			return &os.PathError{Op: "exec", Path: child.Path, Err: err}
		}
		return nil
	}
	child.Stdin, child.Stdout, child.Stderr = cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr()
	return child.Run()
}
