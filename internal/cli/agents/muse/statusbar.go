package muse

import (
	"sync"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// statusBar holds the latest routing status and, while Muse Code runs in its
// terminal, redraws it whenever Muse Code's output allows.
type statusBar struct {
	mu   sync.Mutex
	text string
	// draw is set while the terminal is attached; it redraws the row when the
	// output is at a clean point.
	draw func()
}

func newStatusBar() *statusBar {
	return &statusBar{}
}

func (b *statusBar) set(status agents.Status) {
	b.mu.Lock()
	b.text = "  " + status.String()
	draw := b.draw
	b.mu.Unlock()
	if draw != nil {
		draw()
	}
}

func (b *statusBar) current() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.text
}
