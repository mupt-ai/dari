package muse

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

func TestConfigurePassesTheRoutingKeyAndDefaultModel(t *testing.T) {
	command := agents.Command{Args: []string{"exec", "--", "hi"}, Env: []string{"META_API_KEY=stored-login-env", "HOME=/h"}}
	Configure(&command, "dak_routing", agents.Models{Enabled: []string{"meta/muse-spark-1.3"}})

	want := []string{"exec", "--model", "dari/model/meta/muse-spark-1.3", "--", "hi"}
	if strings.Join(command.Args, "\n") != strings.Join(want, "\n") {
		t.Fatalf("args = %q, want %q", command.Args, want)
	}
	env := strings.Join(command.Env, "\n")
	for _, entry := range []string{"META_API_KEY=dak_routing", "MUSE_NO_AUTO_UPDATE=1", "HOME=/h"} {
		if !strings.Contains(env, entry) {
			t.Fatalf("env missing %q in %q", entry, env)
		}
	}
	if strings.Contains(env, "stored-login-env") {
		t.Fatalf("stored key leaked into env: %q", env)
	}
}

func TestPrepareRoutesMuseCodeThroughALocalProxy(t *testing.T) {
	command := agents.Command{Args: []string{"--", "hi"}}
	if err := Prepare(&command, nil, "dak_routing", "https://routing.example.test/rtr_1"); err != nil {
		t.Fatal(err)
	}
	defer command.Cleanup()
	if command.Run == nil {
		t.Fatal("an interactive launch must own the terminal for its status row")
	}
	args := strings.Join(command.Args, " ")
	if !strings.Contains(args, `-c endpoint_transport.base_url="http://127.0.0.1:`) ||
		!strings.Contains(args, `/v1" -c endpoint_transport.auth="bearer" -- hi`) {
		t.Fatalf("args = %q", command.Args)
	}

	headless := agents.Command{}
	if err := Prepare(&headless, []string{"exec", "hi"}, "dak_routing", "https://routing.example.test"); err != nil {
		t.Fatal(err)
	}
	defer headless.Cleanup()
	if headless.Run != nil {
		t.Fatal("a headless launch must not take over the terminal")
	}
}

func TestProxyForwardsToTheRouterAndReadsMainAgentStatus(t *testing.T) {
	var paths []string
	router := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		if r.URL.Path == "/rtr_1/v1/responses" {
			w.Header().Set("x-dari-selected-model", "meta/muse-spark-1.3")
			w.Header().Set("x-dari-thinking-level", "high")
			w.Header().Set("x-dari-lease-turns-remaining", "6")
		}
		_, _ = io.WriteString(w, "{}")
	}))
	defer router.Close()
	bar := newStatusBar()
	proxy, err := newStatusProxy("dak_routing", router.URL+"/rtr_1", bar.set)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.close()

	send := func(method, path, role, key string) int {
		request, _ := http.NewRequest(method, proxy.url()+path, strings.NewReader("{}"))
		request.Header.Set("Authorization", "Bearer "+key)
		if role != "" {
			request.Header.Set("x-tbh-agent-role", role)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		return response.StatusCode
	}
	if code := send(http.MethodGet, "/muse-code/models", "", "dak_routing"); code != 200 {
		t.Fatalf("models = %d", code)
	}
	if code := send(http.MethodPost, "/v1/responses", "reminder:skill-reminder", "dak_routing"); code != 200 {
		t.Fatalf("reminder = %d", code)
	}
	if got := bar.current(); got != "" {
		t.Fatalf("a reminder observer's reply set the status: %q", got)
	}
	if code := send(http.MethodPost, "/v1/responses", "main", "dak_routing"); code != 200 {
		t.Fatalf("main = %d", code)
	}
	if got, want := bar.current(), "  meta/muse-spark-1.3 · high · lease 7 turns left"; !strings.HasPrefix(got, want) {
		t.Fatalf("status = %q, want prefix %q", got, want)
	}
	if code := send(http.MethodPost, "/v1/responses", "main", "someone-else"); code != http.StatusUnauthorized {
		t.Fatalf("a request without the routing key reached the router: %d", code)
	}
	if code := send(http.MethodGet, "/muse-code/config", "", "dak_routing"); code != http.StatusNotFound {
		t.Fatalf("an unrelated Muse Code path reached the router: %d", code)
	}
	want := []string{
		"GET /rtr_1/muse-code/models Bearer dak_routing",
		"POST /rtr_1/v1/responses Bearer dak_routing",
		"POST /rtr_1/v1/responses Bearer dak_routing",
	}
	if strings.Join(paths, "\n") != strings.Join(want, "\n") {
		t.Fatalf("router saw\n%s\nwant\n%s", strings.Join(paths, "\n"), strings.Join(want, "\n"))
	}
}

func TestHeadlessLaunchesRunDirectly(t *testing.T) {
	for _, args := range [][]string{{"exec", "hi"}, {"--model", "x", "usage"}, {"-c", "a=1", "plugins", "list"}} {
		if interactiveArgs(args) {
			t.Errorf("%q opened the TUI", args)
		}
	}
	for _, args := range [][]string{nil, {"fix the bug"}, {"--model", "exec"}, {"resume", "--last"}, {"--", "exec"}} {
		if !interactiveArgs(args) {
			t.Errorf("%q did not open the TUI", args)
		}
	}
}

func TestScreenFilterKeepsTheStatusRowOutOfScrollRegions(t *testing.T) {
	f := &screenFilter{rows: 44}
	var out bytes.Buffer
	f.write(&out, []byte("a\x1b[r b\x1b[4;10r c\x1b[1;99r d\x1b[5r e\x1b[?1r"))
	want := "a\x1b[1;44r b\x1b[4;10r c\x1b[1;44r d\x1b[5;44r e\x1b[?1r"
	if out.String() != want {
		t.Fatalf("out = %q, want %q", out.String(), want)
	}
}

func TestScreenFilterIsCleanOnlyBetweenSequencesCharactersAndSavedCursors(t *testing.T) {
	f := &screenFilter{rows: 10}
	var out bytes.Buffer
	steps := []struct {
		data  string
		clean bool
	}{
		{"text", true},
		{"\x1b[", false},
		{"r", true},
		{"\xe2\x94", false},
		{"\x80", true},
		{"\x1b]0;title", false},
		{"\x07", true},
		{"\x1b]0;title\x1b", false},
		{"\\", true},
		{"\x1b7\x1b[3;1Hx", false},
		{"\x1b8", true},
		{"\x1b", false},
		{"(B", true},
	}
	for _, step := range steps {
		if got := f.write(&out, []byte(step.data)); got != step.clean {
			t.Fatalf("after %q clean = %v, want %v", step.data, got, step.clean)
		}
	}
	if !strings.Contains(out.String(), "\x1b[1;10r") || !strings.Contains(out.String(), "\xe2\x94\x80") {
		t.Fatalf("out = %q", out.String())
	}
}

func TestStatusRowRestoresTheCursorAndItsVisibility(t *testing.T) {
	f := &screenFilter{rows: 9}
	got := string(f.statusRow("  meta/muse-spark-1.3 · high", 12))
	want := "\x1b7\x1b[?25l\x1b[10;1H\x1b[2K\x1b[2m  meta/muse\x1b[0m\x1b8\x1b[?25h"
	if got != want {
		t.Fatalf("row = %q, want %q", got, want)
	}
	var out bytes.Buffer
	f.write(&out, []byte("\x1b[?25l"))
	if got := string(f.statusRow("x", 12)); strings.Contains(got, "?25") {
		t.Fatalf("a hidden cursor was shown: %q", got)
	}
}

func TestRunWithoutATerminalRunsDirectly(t *testing.T) {
	cmd := exec.Command("sh", "-c", "exit 3")
	err := newStatusBar().run(cmd)
	exitErr, ok := err.(*exec.ExitError)
	if !ok || exitErr.ExitCode() != 3 {
		t.Fatalf("err = %v", err)
	}
}
