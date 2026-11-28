package muse

import (
	"context"
	"strconv"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// Agent is Muse Code.
var Agent = agents.Agent{
	Name:          "muse",
	Label:         "Muse Code",
	Help:          "Launch Muse Code through Dari; forward all following arguments (`dari setup muse` for setup)",
	CodingAgent:   "muse_code",
	Suggestion:    "muse",
	Subscriptions: []string{"meta_muse"},
	RouterKey:     "dari-cli:muse-code",
	Configure: func(command *agents.Command, key, _ string, models agents.Models, _ bool) error {
		Configure(command, key, models)
		return nil
	},
	Prepare: func(_ context.Context, command *agents.Command, args []string, key, baseURL string, _ agents.Models) error {
		return Prepare(command, args, key, baseURL)
	},
	Local: local,
}

// local runs Muse Code on the local model through the bridge, which speaks
// the Responses API.
func local(_ context.Context, command agents.Command, local agents.Local) (agents.Command, error) {
	url, key, err := local.Bridge()
	if err != nil {
		return command, err
	}
	id := agents.Models{Enabled: []string{"local/" + local.Model}, ContextWindow: local.Window}.Default()
	command.Args = agents.InsertBeforeDoubleDash(command.Args, []string{"--model", id, "-c", "endpoint_transport.base_url=" + strconv.Quote(url+"/v1"), "-c", `endpoint_transport.auth="bearer"`})
	command.Env = agents.WithEnvironment(command.Env, map[string]string{"META_API_KEY": key, "MUSE_NO_AUTO_UPDATE": "1"})
	return command, nil
}
