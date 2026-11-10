package cli

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"

	"github.com/mupt-ai/dari/internal/auth"
	"github.com/mupt-ai/dari/internal/state"
)

// loginSpinnerFrames animate the login page while it waits for the browser.
var loginSpinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// loginWithBrowser runs the browser login, taking over the terminal with the
// login page when the streams support it. subtitle names the account context
// the page is signing in for.
func loginWithBrowser(
	ctx context.Context,
	apiURL string,
	stdin io.Reader,
	stderr io.Writer,
	subtitle string,
) (*state.CliState, error) {
	ui := &browserLoginUI{stdin: stdin, stderr: stderr, subtitle: subtitle}
	opts := auth.LoginOptions{Stdin: stdin}
	if agentInputIsTerminal(stdin) && agentInputIsTerminal(stderr) && loginInputPolling {
		opts.Wait = ui.wait
	}
	// The deferred close restores the terminal even on a panic; the explicit
	// one puts the checklist on the normal screen.
	defer ui.close()
	s, err := auth.LoginWithOptions(ctx, apiURL, opts)
	ui.close()
	if err != nil {
		return nil, err
	}
	reportLogin(stderr, s)
	return s, nil
}

// reportLogin lists the account and organization a login stored, whether or
// not the login page ran.
func reportLogin(stderr io.Writer, s *state.CliState) {
	if s.SupabaseSession != nil && s.SupabaseSession.Email != "" {
		agentStep(stderr, "Signed in as "+s.SupabaseSession.Email)
	}
	if org := s.CurrentOrg(); org != nil {
		agentStep(stderr, "Organization: "+org.Name)
	}
}

// browserLoginUI renders the login page.
type browserLoginUI struct {
	stdin    io.Reader
	stderr   io.Writer
	subtitle string
	session  *agentTUISession
}

func (ui *browserLoginUI) pageSubtitle() string {
	if ui.subtitle == "" {
		return "Sign in to the Dari CLI"
	}
	return ui.subtitle
}

// wait draws the page until the browser callback arrives or the user pastes
// the callback URL, so login works from remote machines too.
func (ui *browserLoginUI) wait(
	ctx context.Context,
	loginURL string,
	opened bool,
	await func(context.Context) (auth.CallbackResult, error),
) (auth.CallbackResult, error) {
	file, ok := ui.stdin.(*os.File)
	if !ok {
		return auth.CallbackResult{}, errors.New("interactive login requires a terminal")
	}
	session, err := startAgentTUISession(ui.stdin, ui.stderr)
	if err != nil {
		return auth.CallbackResult{}, err
	}
	ui.session = session
	header := pageHeader(session.width, ui.pageSubtitle())

	waitCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan auth.CallbackResult, 1)
	failures := make(chan error, 1)
	go func() {
		res, err := await(waitCtx)
		if err != nil {
			failures <- err
			return
		}
		results <- res
	}()

	received := func(res auth.CallbackResult) (auth.CallbackResult, error) {
		// An error redirect fails the login next, so don't claim success.
		if res.Error == "" {
			session.renderPage(header, loginCompletingLines())
		}
		return res, nil
	}

	input := agentCodeInputState{}
	var inputErr error
	tick := 0
	for {
		spinner := loginSpinnerFrames[(tick/4)%len(loginSpinnerFrames)]
		session.renderPage(header, loginPageLines(loginURL, opened, input.value, inputErr, spinner, session.width))
		select {
		case res := <-results:
			return received(res)
		case err := <-failures:
			return auth.CallbackResult{}, err
		case <-ctx.Done():
			return auth.CallbackResult{}, ctx.Err()
		default:
		}
		tick++

		raw, err := pollLoginInput(file, loginPollInterval)
		if err != nil {
			return auth.CallbackResult{}, err
		}
		if len(raw) == 0 {
			continue
		}
		submitted, canceled := input.update(raw)
		if canceled {
			return auth.CallbackResult{}, errors.New("login canceled")
		}
		inputErr = nil
		if !submitted || strings.TrimSpace(input.value) == "" {
			continue
		}
		res, err := auth.ParseCallbackURL(input.value)
		if err != nil {
			inputErr = err
			input.value = ""
			continue
		}
		return received(res)
	}
}

// close returns to the normal screen if the page is up.
func (ui *browserLoginUI) close() {
	if ui.session == nil {
		return
	}
	ui.session.Close()
	ui.session = nil
}

func loginPageLines(loginURL string, opened bool, input string, inputErr error, spinner string, width int) []string {
	lines := []string{agentPromptLine("Sign in to Dari"), ""}
	if opened {
		lines = append(lines,
			"  "+ansiGray+"Opened your browser. Finish signing in there."+ansiReset,
			"",
			"  "+ansiGray+"If it didn't open, visit:"+ansiReset,
		)
	} else {
		lines = append(lines, "  "+ansiGray+"Open this URL in your browser to sign in:"+ansiReset)
	}
	lines = append(lines, agentURLLines(loginURL, width)...)
	lines = append(lines,
		"",
		"  "+ansiCoral+spinner+ansiReset+" "+ansiGray+"Waiting for your browser…"+ansiReset,
		"",
		agentCursor(true)+inputDisplay(input, width, "paste the callback URL (remote machines)"),
	)
	if inputErr != nil {
		lines = append(lines, "  "+ansiCoral+inputErr.Error()+ansiReset)
	}
	return append(lines, agentHintLine("enter submit", "ctrl+c cancel"))
}

// loginCompletingLines replaces the wait once the code arrives; the exchange
// and organization setup run while this stays on screen.
func loginCompletingLines() []string {
	return []string{
		"  " + ansiGreen + "✓" + ansiReset + " Browser sign-in complete.",
		"",
		"  " + ansiCoral + "⠸" + ansiReset + " " + ansiGray + "Signing you in…" + ansiReset,
	}
}
