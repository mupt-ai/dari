package muse

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"
)

// screenFilter passes Muse Code's output to a terminal one row taller than
// Muse Code's, keeping that last row out of every scroll region Muse Code
// sets. Muse Code renders inline: it inserts transcript lines above its live
// area and pushes them into scrollback through scroll regions, so a region
// reset must still stop above the status row.
//
// After each write it reports whether the output rests outside any escape
// sequence, multi-byte character, and saved cursor: the only time the status
// row can be drawn without corrupting Muse Code's screen.
type screenFilter struct {
	rows         int // Muse Code's rows, above the status row
	state        int
	sequence     []byte // a CSI sequence until its final byte
	continuation int    // UTF-8 continuation bytes still to come
	savedCursors int    // DECSC not yet restored
	cursorHidden bool
}

const (
	stateGround = iota
	stateEscape
	stateEscapeIntermediate
	stateCSI
	stateString // OSC, DCS, APC, PM, SOS: until BEL or ST
	stateStringEscape
)

// maxSequence bounds a CSI sequence the filter holds; longer ones pass as is.
const maxSequence = 64

func (f *screenFilter) write(out *bytes.Buffer, data []byte) (clean bool) {
	for _, b := range data {
		switch f.state {
		case stateGround:
			switch {
			case f.continuation > 0:
				f.continuation--
				out.WriteByte(b)
			case b == 0x1b:
				f.state = stateEscape
			default:
				f.continuation = utf8Continuation(b)
				out.WriteByte(b)
			}
		case stateEscape:
			switch {
			case b == '[':
				f.sequence = append(f.sequence[:0], 0x1b, '[')
				f.state = stateCSI
			case b == ']' || b == 'P' || b == '_' || b == '^' || b == 'X':
				out.Write([]byte{0x1b, b})
				f.state = stateString
			case b >= 0x20 && b <= 0x2f:
				out.Write([]byte{0x1b, b})
				f.state = stateEscapeIntermediate
			default:
				if b == '7' {
					f.savedCursors++
				} else if b == '8' && f.savedCursors > 0 {
					f.savedCursors--
				}
				out.Write([]byte{0x1b, b})
				f.state = stateGround
			}
		case stateEscapeIntermediate:
			out.WriteByte(b)
			if b >= 0x30 && b <= 0x7e {
				f.state = stateGround
			}
		case stateCSI:
			f.sequence = append(f.sequence, b)
			if b >= 0x40 && b <= 0x7e {
				out.Write(f.csi(f.sequence))
				f.state = stateGround
			} else if len(f.sequence) >= maxSequence {
				out.Write(f.sequence)
				f.state = stateGround
			}
		case stateString:
			out.WriteByte(b)
			if b == 0x07 {
				f.state = stateGround
			} else if b == 0x1b {
				f.state = stateStringEscape
			}
		case stateStringEscape:
			out.WriteByte(b)
			if b == '\\' {
				f.state = stateGround
			} else {
				f.state = stateString
			}
		}
	}
	return f.state == stateGround && f.continuation == 0 && f.savedCursors == 0
}

// csi rewrites a scroll region so it stops above the status row, and tracks
// cursor visibility so drawing the status row can restore it.
func (f *screenFilter) csi(sequence []byte) []byte {
	params := string(sequence[2 : len(sequence)-1])
	switch final := sequence[len(sequence)-1]; {
	case final == 'r' && !strings.HasPrefix(params, "?"):
		top, bottom, _ := strings.Cut(params, ";")
		last, err := strconv.Atoi(bottom)
		if err != nil || last <= 0 || last > f.rows {
			last = f.rows
		}
		if top == "" {
			top = "1"
		}
		return fmt.Appendf(nil, "\x1b[%s;%dr", top, last)
	case params == "?25" && final == 'l':
		f.cursorHidden = true
	case params == "?25" && final == 'h':
		f.cursorHidden = false
	}
	return sequence
}

func utf8Continuation(b byte) int {
	switch {
	case b >= 0xf0:
		return 3
	case b >= 0xe0:
		return 2
	case b >= 0xc0:
		return 1
	}
	return 0
}

// statusRow draws text on the terminal's last row and returns the cursor to
// where Muse Code left it.
func (f *screenFilter) statusRow(text string, cols int) []byte {
	var row bytes.Buffer
	row.WriteString("\x1b7")
	if !f.cursorHidden {
		row.WriteString("\x1b[?25l")
	}
	fmt.Fprintf(&row, "\x1b[%d;1H\x1b[2K\x1b[2m%s\x1b[0m\x1b8", f.rows+1, truncate(text, cols-1))
	if !f.cursorHidden {
		row.WriteString("\x1b[?25h")
	}
	return row.Bytes()
}

// scrollRegion keeps the status row out of scrolling after a resize.
func (f *screenFilter) scrollRegion() []byte {
	return fmt.Appendf(nil, "\x1b7\x1b[1;%dr\x1b8", f.rows)
}

func truncate(text string, width int) string {
	runes := []rune(text)
	if width < 0 {
		width = 0
	}
	if len(runes) > width {
		runes = runes[:width]
	}
	return string(runes)
}
