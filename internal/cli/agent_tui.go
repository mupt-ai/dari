package cli

import (
	"cmp"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"golang.org/x/term"
)

// Onboarding prompts take over the terminal's alternate screen, like Codex's
// onboarding, so each step is a clean page. When a prompt is answered the
// terminal returns to its normal screen and a one-line summary is printed
// there, leaving a short checklist behind.

const (
	ansiReset = "\033[0m"
	ansiBold  = "\033[1m"
	ansiDim   = "\033[2m"
	ansiCoral = "\033[38;5;209m"
	ansiCyan  = "\033[38;5;117m"
	ansiGreen = "\033[38;5;114m"
	ansiGray  = "\033[38;5;245m"
	ansiRed   = "\033[38;5;203m"
)

func agentInputIsTerminal(stream any) bool {
	file, ok := stream.(*os.File)
	return ok && term.IsTerminal(int(file.Fd()))
}

// agentStep reports a finished onboarding step.
func agentStep(stderr io.Writer, text string) {
	if agentInputIsTerminal(stderr) {
		agentPrintln(stderr, ansiGreen+"✓"+ansiReset+" "+text)
		return
	}
	agentPrintln(stderr, text)
}

// agentScreen keeps onboarding on the alternate screen from its first page to
// its last once held, so answering one prompt never flashes the normal
// screen before the next page draws. Lines printed meanwhile wait until the
// screen is released.
var agentScreen struct {
	held    bool
	active  bool
	stderr  io.Writer
	lines   []string
	signals chan os.Signal
}

// holdAgentScreen keeps the alternate screen between pages until
// releaseAgentScreen. Between pages the terminal is back in normal mode, so
// an interrupt there releases the screen before the process exits.
func holdAgentScreen() {
	agentScreen.held = true
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	agentScreen.signals = signals
	go func() {
		if _, ok := <-signals; ok {
			releaseAgentScreen()
			os.Exit(130)
		}
	}()
}

// releaseAgentScreen returns to the normal screen and prints the lines held
// for it.
func releaseAgentScreen() {
	if agentScreen.signals != nil {
		signal.Stop(agentScreen.signals)
		close(agentScreen.signals)
	}
	if agentScreen.active {
		fmt.Fprint(agentScreen.stderr, "\033[?25h\033[?1049l")
		for _, line := range agentScreen.lines {
			fmt.Fprintln(agentScreen.stderr, line)
		}
	}
	agentScreen.held, agentScreen.active, agentScreen.stderr, agentScreen.lines, agentScreen.signals = false, false, nil, nil, nil
}

// agentPrintln prints an onboarding line, or holds it while the alternate
// screen is showing.
func agentPrintln(stderr io.Writer, line string) {
	if agentScreen.active {
		agentScreen.lines = append(agentScreen.lines, line)
		return
	}
	fmt.Fprintln(stderr, line)
}

func agentPromptLine(prompt string) string {
	return ansiCoral + "◆" + ansiReset + " " + ansiBold + prompt + ansiReset
}

func agentHintLine(hints ...string) string {
	return "  " + ansiGray + strings.Join(hints, " · ") + ansiReset
}

// agentCursor fills the two-column gutter under a prompt's ◆, so option text
// lines up with the prompt's other lines.
func agentCursor(active bool) string {
	if active {
		return ansiCoral + "❯ " + ansiReset
	}
	return "  "
}

type agentTUISession struct {
	file     *os.File
	stderr   io.Writer
	oldState *term.State
	// width and height are what remains inside the page margin.
	width, height int
}

// agentPageMargin indents every page, under a header, from the terminal's
// top-left corner.
const agentPageMargin = "  "

func startAgentTUISession(stdin io.Reader, stderr io.Writer) (*agentTUISession, error) {
	file, ok := stdin.(*os.File)
	if !ok {
		return nil, errors.New("interactive onboarding requires a terminal")
	}
	fd := int(file.Fd())
	oldState, err := term.MakeRaw(fd)
	if err != nil {
		return nil, fmt.Errorf("enter interactive mode: %w", err)
	}
	discardAgentInput(fd)
	session := &agentTUISession{file: file, stderr: stderr, oldState: oldState}
	if w, h, err := term.GetSize(fd); err == nil {
		session.width, session.height = w-len(agentPageMargin), h-6
	}
	if !agentScreen.active {
		fmt.Fprint(stderr, "\033[?1049h")
		agentScreen.active, agentScreen.stderr = true, stderr
	}
	fmt.Fprint(stderr, "\033[?25l")
	return session, nil
}

// Close returns to the normal screen so the caller can print its summary,
// unless onboarding holds the screen for its next page.
func (session *agentTUISession) Close() {
	_ = term.Restore(int(session.file.Fd()), session.oldState)
	if !agentScreen.held {
		releaseAgentScreen()
	}
}

// agentPageHeader is the welcome box at the top of every onboarding page.
func agentPageHeader(width int) []string {
	return pageHeader(width, "Setting up your coding agent")
}

// pageHeader is the welcome box at the top of a page, centered in width.
func pageHeader(width int, subtitle string) []string {
	title := ansiCoral + "⑂" + ansiReset + " " + ansiBold + "dari.dev" + ansiReset
	subtitleLine := ansiGray + subtitle + ansiReset
	inner := max(ansiVisibleWidth(title), ansiVisibleWidth(subtitleLine)) + 4
	row := func(text string) string {
		pad := inner - ansiVisibleWidth(text)
		return ansiGray + "│" + ansiReset + strings.Repeat(" ", pad/2) + text + strings.Repeat(" ", pad-pad/2) + ansiGray + "│" + ansiReset
	}
	indent := strings.Repeat(" ", max(width-inner-2, 0)/2)
	return []string{
		indent + ansiGray + "╭" + strings.Repeat("─", inner) + "╮" + ansiReset,
		indent + row(title),
		indent + row(subtitleLine),
		indent + ansiGray + "╰" + strings.Repeat("─", inner) + "╯" + ansiReset,
		"",
	}
}

// render draws a page from the top of the screen. Raw mode disables output
// post-processing, so lines end in \r\n.
func (session *agentTUISession) render(lines []string) {
	session.renderPage(agentPageHeader(session.width), lines)
}

func (session *agentTUISession) renderPage(header, lines []string) {
	var frame strings.Builder
	frame.WriteString("\033[H\033[K\r\n")
	for _, line := range append(header, lines...) {
		frame.WriteString(agentPageMargin + line + ansiReset + "\033[K\r\n")
	}
	frame.WriteString("\033[J")
	_, _ = session.stderr.Write([]byte(frame.String()))
}

// clipText shortens plain text to width cells, marking the cut with an
// ellipsis.
func clipText(text string, width int) string {
	if width < 1 {
		return ""
	}
	if len(text) <= width {
		return text
	}
	if width == 1 {
		return "…"
	}
	return text[:width-1] + "…"
}

// ansiVisibleWidth counts printable cells, skipping CSI sequences and OSC
// hyperlinks.
func ansiVisibleWidth(s string) int {
	width, escape, osc := 0, false, false
	for i, r := range s {
		switch {
		case osc:
			if r == '\\' && i > 0 && s[i-1] == '\033' {
				osc = false
			}
		case escape:
			if r == ']' && i > 0 && s[i-1] == '\033' {
				escape, osc = false, true
			} else if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
				escape = false
			}
		case r == '\033':
			escape = true
		default:
			width++
		}
	}
	return width
}

func parseAgentPickerKeys(raw []byte) []string {
	keys := []string{}
	for i := 0; i < len(raw); {
		if raw[i] == 0x1b && i+2 < len(raw) && raw[i+1] == '[' {
			switch raw[i+2] {
			case 'A':
				keys = append(keys, "up")
			case 'B':
				keys = append(keys, "down")
			case 'C':
				keys = append(keys, "right")
			case 'D':
				keys = append(keys, "left")
			}
			i += 3
			continue
		}
		switch raw[i] {
		case '\r', '\n':
			keys = append(keys, "enter")
		case 0x1b:
			keys = append(keys, "esc")
		case ' ':
			keys = append(keys, " ")
		case 'q', 'Q', 0x03:
			keys = append(keys, "quit")
		case 'k', 'j', 'h', 'l', 'a', 's', '1', '2', '3', '4', '5', '6', '7', '8', '9':
			keys = append(keys, string(raw[i]))
		}
		i++
	}
	return keys
}

type agentChoiceOption struct {
	label string
	note  string
	// description explains the option on its own line below it.
	description string
	// done replaces the prompt once this option is chosen; empty prints
	// nothing.
	done string
}

// runAgentChoiceTUI asks one question, with optional detail lines between the
// prompt and its options. Arrow keys and Enter choose, as does typing an
// option's number.
func runAgentChoiceTUI(stdin io.Reader, stderr io.Writer, prompt string, details []string, options []agentChoiceOption) (int, error) {
	if len(options) == 0 {
		return 0, errors.New("interactive selection has no options")
	}
	session, err := startAgentTUISession(stdin, stderr)
	if err != nil {
		return 0, err
	}
	choice, err := func() (int, error) {
		defer session.Close()
		cursor := 0
		buf := make([]byte, 256)
		for {
			session.render(agentChoiceLines(prompt, details, options, cursor))
			n, readErr := session.file.Read(buf)
			for _, key := range parseAgentPickerKeys(buf[:n]) {
				switch key {
				case "up", "k":
					cursor = (cursor - 1 + len(options)) % len(options)
				case "down", "j":
					cursor = (cursor + 1) % len(options)
				case "enter":
					return cursor, nil
				case "quit", "esc":
					return 0, errors.New("agent onboarding canceled")
				default:
					if index := int(key[0] - '1'); len(key) == 1 && index >= 0 && index < len(options) {
						return index, nil
					}
				}
			}
			if readErr != nil {
				return 0, fmt.Errorf("read selection: %w", readErr)
			}
		}
	}()
	if err == nil && options[choice].done != "" {
		agentStep(stderr, options[choice].done)
	}
	return choice, err
}

func agentChoiceLines(prompt string, details []string, options []agentChoiceOption, cursor int) []string {
	lines := append([]string{agentPromptLine(prompt)}, details...)
	for index, option := range options {
		label := fmt.Sprintf("%d. %s", index+1, option.label)
		if index == cursor {
			label = ansiBold + label + ansiReset
		}
		line := agentCursor(index == cursor) + label
		if option.note != "" {
			line += "  " + ansiGreen + option.note + ansiReset
		}
		lines = append(lines, line)
		if option.description != "" {
			lines = append(lines, "     "+ansiGray+option.description+ansiReset)
		}
	}
	return append(lines, agentHintLine("↑↓ move", "enter confirm", "esc cancel"))
}

func agentOpenedLine(provider agentSubscriptionProvider, opened bool) string {
	if opened {
		return "  " + ansiGray + "Opened " + provider.name + " in your browser. If it didn't open, visit:" + ansiReset
	}
	return "  " + ansiGray + "Open this URL to sign in to " + provider.name + ":" + ansiReset
}

// agentURLLines wraps a URL inside the prompt's indent, preferring to break
// between query parameters. Each piece links to the whole URL, so it stays
// clickable across the breaks.
func agentURLLines(url string, width int) []string {
	const indent = "  "
	per := width - len(indent) - 1
	if per <= 0 {
		per = len(url)
	}
	lines := []string{}
	for _, piece := range wrapURL(url, per) {
		lines = append(lines, indent+"\033]8;;"+url+"\033\\"+ansiCyan+piece+ansiReset+"\033]8;;\033\\")
	}
	return lines
}

// wrapURL splits url into pieces of at most per bytes, starting a new piece at
// a query separator whenever one is in reach.
func wrapURL(url string, per int) []string {
	pieces := []string{}
	for rest := url; rest != ""; {
		if len(rest) <= per {
			pieces = append(pieces, rest)
			break
		}
		cut := strings.LastIndexByte(rest[:per+1], '&')
		if cut <= 0 {
			cut = per
		}
		pieces = append(pieces, rest[:cut])
		rest = rest[cut:]
	}
	return pieces
}

func agentOAuthLines(provider agentSubscriptionProvider, authorizationURL string, opened bool, value string, width int) []string {
	lines := []string{agentPromptLine("Connect " + provider.name), agentOpenedLine(provider, opened)}
	lines = append(lines, agentURLLines(authorizationURL, width)...)
	return append(lines,
		"",
		"  Paste the code "+provider.vendor+" shows after you approve:",
		agentCursor(true)+inputDisplay(value, width, "code#state"),
		agentHintLine("enter submit", "ctrl+c cancel"),
	)
}

func runAgentCodeInputTUI(
	provider agentSubscriptionProvider,
	stdin io.Reader,
	stderr io.Writer,
	authorizationURL string,
	opened bool,
) (string, error) {
	session, err := startAgentTUISession(stdin, stderr)
	if err != nil {
		return "", err
	}
	defer session.Close()

	input := agentCodeInputState{}
	buf := make([]byte, 256)
	for {
		session.render(agentOAuthLines(provider, authorizationURL, opened, input.value, session.width))
		n, readErr := session.file.Read(buf)
		submitted, canceled := input.update(buf[:n])
		if canceled {
			return "", fmt.Errorf("%s authorization canceled", provider.name)
		}
		if submitted && strings.TrimSpace(input.value) != "" {
			return input.value, nil
		}
		if readErr != nil {
			return "", fmt.Errorf("read %s authorization code: %w", provider.name, readErr)
		}
	}
}

// runAgentDeviceCodeTUI shows the device code until the user confirms they
// approved it and complete reports anything other than a pending approval.
func runAgentDeviceCodeTUI(
	provider agentSubscriptionProvider,
	stdin io.Reader,
	stderr io.Writer,
	authorizationURL string,
	userCode string,
	opened bool,
	complete func() (pending bool, err error),
) error {
	session, err := startAgentTUISession(stdin, stderr)
	if err != nil {
		return err
	}
	defer session.Close()

	status := agentHintLine("enter after approving", "ctrl+c cancel")
	buf := make([]byte, 256)
	for {
		lines := []string{agentPromptLine("Connect " + provider.name), agentOpenedLine(provider, opened)}
		lines = append(lines, agentURLLines(authorizationURL, session.width)...)
		session.render(append(lines,
			"",
			"  Enter this code at "+provider.vendor+":  "+ansiCoral+ansiBold+userCode+ansiReset,
			status,
		))
		n, readErr := session.file.Read(buf)
		for _, key := range parseAgentPickerKeys(buf[:n]) {
			switch key {
			case "quit":
				return fmt.Errorf("%s authorization canceled", provider.name)
			case "enter":
				pending, err := complete()
				if !pending {
					return err
				}
				status = agentHintLine("Still waiting for approval. Press enter to check again", "ctrl+c cancel")
			}
		}
		if readErr != nil {
			return fmt.Errorf("read %s approval: %w", provider.name, readErr)
		}
	}
}

// runAgentSecretInputTUI is a page that reads a secret without showing it.
// Enter passes it to submit, whose error is shown on the page for another
// try; esc leaves without one. It reports whether submit succeeded.
func runAgentSecretInputTUI(stdin io.Reader, stderr io.Writer, title string, details []string, submit func(string) error) (bool, error) {
	session, err := startAgentTUISession(stdin, stderr)
	if err != nil {
		return false, err
	}
	defer session.Close()

	input := agentCodeInputState{}
	status := ""
	buf := make([]byte, 4096)
	for {
		lines := append([]string{agentPromptLine(title)}, details...)
		if len(details) > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, agentCursor(true)+secretDisplay(input.value, session.width))
		if status != "" {
			lines = append(lines, "  "+ansiRed+status+ansiReset)
		}
		session.render(append(lines, agentHintLine("enter save", "esc back")))
		n, readErr := session.file.Read(buf)
		// A lone escape byte is the esc key; arrows and other keys arrive as
		// longer sequences in one read.
		if n == 1 && buf[0] == 0x1b {
			return false, nil
		}
		submitted, canceled := input.update(buf[:n])
		if canceled {
			return false, nil
		}
		if submitted {
			value := strings.TrimSpace(input.value)
			if value == "" {
				status = "Paste a key, or press esc to go back."
				continue
			}
			if err := submit(value); err != nil {
				status = err.Error()
				continue
			}
			return true, nil
		}
		if readErr != nil {
			return false, readErr
		}
	}
}

// secretDisplay masks a secret, keeping its length visible up to the width.
func secretDisplay(value string, width int) string {
	if value == "" {
		return ansiDim + "Paste your API key" + ansiReset
	}
	return ansiCyan + strings.Repeat("•", min(len(value), max(width-6, 8))) + ansiReset
}

type agentCodeInputState struct {
	value  string
	escape bool
	csi    bool
}

func (input *agentCodeInputState) update(raw []byte) (bool, bool) {
	for _, value := range raw {
		if input.escape {
			if input.csi {
				if isTerminalEscapeFinal(value) {
					input.escape = false
					input.csi = false
				}
				continue
			}
			input.escape = false
			if value == '[' {
				input.escape = true
				input.csi = true
				continue
			}
		}
		if value == 0x1b {
			input.escape = true
			continue
		}
		switch value {
		case '\r', '\n':
			return true, false
		case 0x03:
			return false, true
		case 0x08, 0x7f:
			if len(input.value) > 0 {
				input.value = input.value[:len(input.value)-1]
			}
		default:
			if value >= 0x20 && value <= 0x7e {
				input.value += string(value)
			}
		}
	}
	return false, false
}

func isTerminalEscapeFinal(value byte) bool {
	return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') || value == '~'
}

func inputDisplay(input string, width int, placeholder string) string {
	if input == "" {
		if width > 0 {
			placeholder = clipText(placeholder, width-6)
		}
		return ansiDim + placeholder + ansiReset
	}
	available := width - 6
	if available <= 0 || len(input) <= available {
		return ansiCyan + input + ansiReset
	}
	return ansiGray + "…" + ansiReset + ansiCyan + input[len(input)-available+1:] + ansiReset
}

// errAgentWantsAutorouting is the model picker's answer when the user asks
// for the Autorouting plan instead of choosing.
var errAgentWantsAutorouting = errors.New("autorouting requested")

func runAgentPicker(
	stdin io.Reader,
	stderr io.Writer,
	title string,
	note []string,
	offerAutorouting bool,
	models []agentModel,
	defaults []string,
	currentLevels map[string][]string,
	recommendedLevels map[string][]string,
	sources map[string][]agentModelSource,
) ([]agentModelChoice, error) {
	p := newAgentPickerState(models, defaults, currentLevels, recommendedLevels, sources)
	if len(p.rows) == 0 {
		return nil, errors.New("no managed-key models are available")
	}
	session, err := startAgentTUISession(stdin, stderr)
	if err != nil {
		return nil, err
	}
	choices, err := func() ([]agentModelChoice, error) {
		defer session.Close()
		buf := make([]byte, 256)
		for {
			session.render(agentPickerLines(title, note, p, agentPickerVisibleRows(session.height)))
			n, readErr := session.file.Read(buf)
			for _, key := range parseAgentPickerKeys(buf[:n]) {
				if key == "a" && offerAutorouting && !p.editing {
					return nil, errAgentWantsAutorouting
				}
				done, canceled := p.handleKey(key)
				if canceled {
					return nil, errors.New("model selection canceled")
				}
				if done {
					return p.choices(), nil
				}
			}
			if readErr != nil {
				if errors.Is(readErr, io.EOF) {
					return nil, errors.New("model selection canceled")
				}
				return nil, fmt.Errorf("read selection: %w", readErr)
			}
		}
	}()
	if err == nil {
		agentStep(stderr, "Models: "+agentPickerSummary(p))
	}
	return choices, err
}

// agentPickerVisibleRows leaves room for the prompt, hints, and a level list.
func agentPickerVisibleRows(height int) int {
	if height <= 0 {
		return 12
	}
	return max(height-12, 5)
}

func agentPickerSummary(p *agentPickerState) string {
	names := []string{}
	for _, row := range p.rows {
		if row.selected {
			names = append(names, row.model.DisplayName)
		}
	}
	if len(names) > 3 {
		return strings.Join(names[:3], ", ") + fmt.Sprintf(" +%d more", len(names)-3)
	}
	return strings.Join(names, ", ")
}

func agentPickerLines(title string, note []string, p *agentPickerState, visible int) []string {
	lines := []string{agentPromptLine(title)}
	for _, line := range note {
		lines = append(lines, "  "+ansiGray+line+ansiReset)
	}
	if p.cursor < p.offset {
		p.offset = p.cursor
	}
	if p.cursor >= p.offset+visible {
		p.offset = p.cursor - visible + 1
	}
	end := min(p.offset+visible, len(p.rows))
	nameWidth, levelWidth := 0, 0
	for _, row := range p.rows {
		nameWidth = max(nameWidth, len(row.model.DisplayName))
		levelWidth = max(levelWidth, len(cmp.Or(strings.Join(row.checkedLevels(), ", "), "default")))
	}
	if p.offset > 0 {
		lines = append(lines, "  "+ansiGray+fmt.Sprintf("↑ %d more", p.offset)+ansiReset)
	}
	for i := p.offset; i < end; i++ {
		row := p.rows[i]
		active := i == p.cursor && !p.editing
		name := fmt.Sprintf("%-*s", nameWidth, row.model.DisplayName)
		switch {
		case active:
			name = ansiBold + name + ansiReset
		case !row.selected:
			name = ansiGray + name + ansiReset
		}
		levels := strings.Join(row.checkedLevels(), ", ")
		if levels == "" {
			levels = "default"
		}
		levels = fmt.Sprintf("%-*s", levelWidth, levels)
		source := ""
		if len(row.sources) > 0 {
			source = "  " + row.sources[row.source].label
			if !row.selected {
				source = "  " + ansiGray + row.sources[row.source].label + ansiReset
			}
		}
		note := ""
		if row.usesRecommended() {
			note = "  " + ansiGreen + "recommended" + ansiReset
		}
		lines = append(lines, agentCursor(active)+agentCheckbox(row.selected)+" "+name+"  "+ansiCyan+levels+ansiReset+source+note)
		if p.editing && i == p.cursor {
			for j, level := range row.levelOpts {
				rec := ""
				if row.recommended[level] {
					rec = "  " + ansiGreen + "recommended" + ansiReset
				}
				label := level
				if j == p.levelCursor {
					label = ansiBold + label + ansiReset
				}
				lines = append(lines, "    "+agentCursor(j == p.levelCursor)+agentCheckbox(row.checked[level])+" "+label+rec)
			}
		}
	}
	if end < len(p.rows) {
		lines = append(lines, "  "+ansiGray+fmt.Sprintf("↓ %d more", len(p.rows)-end)+ansiReset)
	}
	if p.editing {
		return append(lines, agentHintLine("↑↓ move", "space toggle thinking level", "← done"))
	}
	return append(lines, agentHintLine("↑↓ move", "space toggle", "→ thinking levels", "s payment", "enter confirm", "esc cancel"))
}

func agentCheckbox(checked bool) string {
	if checked {
		return ansiCoral + "◉" + ansiReset
	}
	return ansiGray + "○" + ansiReset
}
