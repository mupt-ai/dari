package cli

import (
	"context"
	"errors"
	"io"

	"github.com/mupt-ai/dari/inference"
)

// Pick before normal routing or engine discovery: opening or canceling the
// picker must not sign in, contact a listener, or load weights.
func chooseLaunchRoute(ctx context.Context, l *agentLaunch, in io.Reader, out, stderr io.Writer) error {
	if !agentInputIsTerminal(in) || !agentInputIsTerminal(stderr) {
		return errors.New("--include-local requires a terminal; for scripts use --local MODEL or omit the flag for normal routing")
	}
	models, err := inference.ModelNames()
	if err != nil {
		return err
	}
	options := []agentChoiceOption{{label: "Normal Dari Routing", note: "Keep your usual setup"}}
	for _, model := range models {
		options = append(options, agentChoiceOption{label: model, note: "Use local or forwarded engine; no download"})
	}
	options = append(options, agentChoiceOption{label: "Set Up a Local Model", note: "Choose a model to download"})
	pick, err := runAgentRootChoiceTUI(in, stderr, "Choose a Route for This Session", nil, options)
	if err != nil || pick == 0 {
		return err
	}
	if pick <= len(models) {
		l.localModel = models[pick-1]
		return nil
	}
	options = nil
	for _, model := range models {
		options = append(options, agentChoiceOption{label: "Pull " + model + " and Launch"})
	}
	pick, err = runAgentRootChoiceTUI(in, stderr, "Install a Local Model", []string{"This installs the runtime and official weights, just like dari pull."}, options)
	if err != nil {
		return err
	}
	l.localModel = models[pick]
	return runInference(ctx, cliVersion, in, out, stderr, "pull", l.localModel)
}
