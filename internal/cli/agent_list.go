package cli

import (
	"slices"

	"github.com/mupt-ai/dari/internal/cli/agents"
	"github.com/mupt-ai/dari/internal/cli/agents/claude"
	"github.com/mupt-ai/dari/internal/cli/agents/codex"
	"github.com/mupt-ai/dari/internal/cli/agents/hermes"
	"github.com/mupt-ai/dari/internal/cli/agents/muse"
	"github.com/mupt-ai/dari/internal/cli/agents/openclaw"
	"github.com/mupt-ai/dari/internal/cli/agents/opencode"
	"github.com/mupt-ai/dari/internal/cli/agents/pi"
)

// agentList is every coding agent Dari launches, in the order Dari lists
// them. Each is defined in its own package under agents/.
var agentList = []agents.Agent{
	claude.Agent,
	codex.Agent,
	muse.Agent,
	opencode.Agent,
	pi.Agent,
	openclaw.Agent,
	hermes.Agent,
}

// agentNamed is the agent `dari <name>` launches.
func agentNamed(name string) (agents.Agent, bool) {
	for _, agent := range agentList {
		if agent.Name == name {
			return agent, true
		}
	}
	return agents.Agent{}, false
}

// agentNames are the agents' names, sorted.
func agentNames() []string {
	names := make([]string, len(agentList))
	for i, agent := range agentList {
		names[i] = agent.Name
	}
	slices.Sort(names)
	return names
}
