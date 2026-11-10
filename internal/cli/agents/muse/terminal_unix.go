//go:build !windows

package muse

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"golang.org/x/term"
)

// run starts Muse Code on a pseudo-terminal one row shorter than the user's
// and draws the routing status on the row left over. Without a terminal it
// runs Muse Code directly.
func (b *statusBar) run(cmd *exec.Cmd) error {
	in, out := int(os.Stdin.Fd()), int(os.Stdout.Fd())
	if !term.IsTerminal(in) || !term.IsTerminal(out) {
		return cmd.Run()
	}
	cols, rows, err := term.GetSize(out)
	if err != nil || rows < 4 || cols < 10 {
		return cmd.Run()
	}

	filter := &screenFilter{rows: rows - 1}
	// Leave a free row under the cursor, then keep it out of scrolling.
	_, _ = os.Stdout.WriteString("\n\x1b[A")
	_, _ = os.Stdout.Write(filter.scrollRegion())

	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows - 1), Cols: uint16(cols)})
	if err != nil {
		_, _ = os.Stdout.WriteString("\x1b7\x1b[r\x1b8")
		return err
	}
	defer ptmx.Close()
	saved, err := term.MakeRaw(in)
	if err == nil {
		defer func() { _ = term.Restore(in, saved) }()
	}

	var mu sync.Mutex
	clean, resized := true, false
	redraw := func() {
		var frame bytes.Buffer
		if resized {
			frame.Write(filter.scrollRegion())
			resized = false
		}
		frame.Write(filter.statusRow(b.current(), cols))
		_, _ = os.Stdout.Write(frame.Bytes())
	}
	b.mu.Lock()
	b.draw = func() {
		mu.Lock()
		defer mu.Unlock()
		if clean {
			redraw()
		}
	}
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.draw = nil
		b.mu.Unlock()
	}()

	resizes := make(chan os.Signal, 1)
	signal.Notify(resizes, syscall.SIGWINCH)
	defer signal.Stop(resizes)
	go func() {
		for range resizes {
			newCols, newRows, err := term.GetSize(out)
			if err != nil || newRows < 4 {
				continue
			}
			mu.Lock()
			cols, filter.rows, resized = newCols, newRows-1, true
			_ = pty.Setsize(ptmx, &pty.Winsize{Rows: uint16(newRows - 1), Cols: uint16(newCols)})
			if clean {
				redraw()
			}
			mu.Unlock()
		}
	}()

	go func() { _, _ = io.Copy(ptmx, os.Stdin) }()
	copied := make(chan struct{})
	go func() {
		defer close(copied)
		buf := make([]byte, 32<<10)
		var frame bytes.Buffer
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				mu.Lock()
				frame.Reset()
				clean = filter.write(&frame, buf[:n])
				if clean {
					if resized {
						frame.Write(filter.scrollRegion())
						resized = false
					}
					frame.Write(filter.statusRow(b.current(), cols))
				}
				_, _ = os.Stdout.Write(frame.Bytes())
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()

	waitErr := cmd.Wait()
	<-copied
	mu.Lock()
	defer mu.Unlock()
	// Give the row back: full-screen scrolling and an empty last row.
	_, _ = fmt.Fprintf(os.Stdout, "\x1b7\x1b[r\x1b8\x1b7\x1b[%d;1H\x1b[2K\x1b8", filter.rows+1)
	return waitErr
}
