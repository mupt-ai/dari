package auth

import (
	"bufio"
	"cmp"
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// CallbackResult is the data we extract from the OAuth redirect.
type CallbackResult struct {
	Code  string
	State string
	Error string
}

// check rejects a redirect that carried neither a code nor an error.
func (res CallbackResult) check() (CallbackResult, error) {
	if res.Code == "" && res.Error == "" {
		return res, errors.New("browser callback did not include a code")
	}
	return res, nil
}

// callbackServer binds to 127.0.0.1 on an ephemeral port and blocks on a
// single GET /callback request. The returned redirect URL is what gets
// threaded into the Supabase authorize URL.
//
// Usage:
//
//	server, err := startCallbackServer()
//	// ... open browser with server.RedirectURL ...
//	result, err := server.Wait(ctx, 5*time.Minute)
//	server.Close()
type callbackServer struct {
	RedirectURL string

	srv    *http.Server
	result chan CallbackResult
	once   sync.Once
}

func startCallbackServer() (*callbackServer, error) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("bind local callback listener: %w", err)
	}
	addr := lis.Addr().(*net.TCPAddr)
	cb := &callbackServer{
		RedirectURL: fmt.Sprintf("http://127.0.0.1:%d/callback", addr.Port),
		result:      make(chan CallbackResult, 1),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		res := CallbackResult{
			Code:  q.Get("code"),
			State: q.Get("state"),
			Error: cmp.Or(q.Get("error_description"), q.Get("error")),
		}
		status := http.StatusOK
		page := callbackPage{
			title:   "Signed in to Dari",
			message: "You can close this tab and return to your terminal.",
		}
		if res.Error != "" {
			status = http.StatusBadRequest
			page = callbackPage{title: "Sign-in didn't finish", message: res.Error, failed: true}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(page.render()))

		cb.once.Do(func() { cb.result <- res })
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})

	cb.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = cb.srv.Serve(lis) }()
	return cb, nil
}

// Close tears down the callback listener. Safe to call multiple times.
func (cb *callbackServer) Close() {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = cb.srv.Shutdown(shutdownCtx)
}

// Wait blocks until the browser callback fires.
func (cb *callbackServer) Wait(ctx context.Context, timeout time.Duration) (CallbackResult, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	select {
	case res := <-cb.result:
		return res.check()
	case <-deadline.C:
		return CallbackResult{}, errors.New("timed out waiting for browser login to complete")
	case <-ctx.Done():
		return CallbackResult{}, ctx.Err()
	}
}

// WaitOrInput blocks until either the local callback fires or the user pastes
// the redirected callback URL. The paste path makes `dari auth login` work
// from remote VMs without requiring a separate command or flag.
func (cb *callbackServer) WaitOrInput(ctx context.Context, r io.Reader, timeout time.Duration) (CallbackResult, error) {
	if r == nil {
		r = os.Stdin
	}
	fmt.Fprint(os.Stderr, "Paste callback URL: ")
	if file, ok := r.(*os.File); ok && supportsCallbackPolling {
		return cb.waitFileInput(ctx, file, timeout)
	}

	lineCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(r)
		if scanner.Scan() {
			lineCh <- scanner.Text()
			return
		}
		if err := scanner.Err(); err != nil {
			errCh <- err
			return
		}
		errCh <- io.EOF
	}()

	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case res := <-cb.result:
			return res.check()
		case raw := <-lineCh:
			return ParseCallbackURL(raw)
		case err := <-errCh:
			if err != nil && !errors.Is(err, io.EOF) {
				return CallbackResult{}, fmt.Errorf("read callback URL: %w", err)
			}
			errCh = nil
		case <-deadline.C:
			return CallbackResult{}, errors.New("timed out waiting for browser login to complete")
		case <-ctx.Done():
			return CallbackResult{}, ctx.Err()
		}
	}
}

// ParseCallbackURL reads a callback URL pasted from a browser that cannot
// reach this machine's loopback listener.
func ParseCallbackURL(raw string) (CallbackResult, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return CallbackResult{}, errors.New("empty callback URL")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return CallbackResult{}, fmt.Errorf("parse callback URL: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return CallbackResult{}, errors.New("paste the full localhost callback URL, not just the code")
	}
	if scheme := strings.ToLower(u.Scheme); scheme != "http" && scheme != "https" {
		return CallbackResult{}, errors.New("callback URL must use http or https")
	}

	q := u.Query()
	res := CallbackResult{
		Code:  q.Get("code"),
		State: q.Get("state"),
		Error: cmp.Or(q.Get("error_description"), q.Get("error")),
	}
	if res.Code == "" && res.Error == "" {
		return res, errors.New("callback URL did not include a code")
	}
	if res.Code != "" && res.State == "" {
		return res, errors.New("callback URL did not include state")
	}
	return res, nil
}

// callbackPage is what the browser tab shows once the CLI login finishes.
type callbackPage struct {
	title   string
	message string
	failed  bool
}

func (p callbackPage) render() string {
	mark := "✓"
	if p.failed {
		mark = "×"
	}
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>` + html.EscapeString(p.title) + `</title>
<style>
:root { color-scheme: light dark; --bg: #fbfaf9; --fg: #1b1a19; --muted: #6d6a66; --line: #e6e2dd; --accent: #d9694a; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b0b0c; --fg: #eae7e3; --muted: #96928d; --line: #26252a; --accent: #e8825a; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
       font: 16px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { width: min(26rem, calc(100vw - 3rem)); border: 1px solid var(--line); padding: 2.5rem 2rem; text-align: center; }
.mark { color: var(--accent); font-size: 1.75rem; line-height: 1; }
h1 { margin: 1rem 0 .5rem; font-size: 1.0625rem; font-weight: 600; letter-spacing: -.01em; }
p { margin: 0; color: var(--muted); font-size: .9375rem; }
</style>
</head>
<body>
<main>
<div class="mark">` + mark + `</div>
<h1>` + html.EscapeString(p.title) + `</h1>
<p>` + html.EscapeString(p.message) + `</p>
</main>
</body>
</html>
`
}
