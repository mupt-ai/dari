package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mupt-ai/dari/internal/api"
	"github.com/mupt-ai/dari/internal/gateway"
)

func TestPrivateModeSetsThisComputersGateway(t *testing.T) {
	if err := gateway.Save(gateway.Settings{Mode: gateway.ModeHosted, LocalKey: "local"}); err != nil {
		t.Fatal(err)
	}
	private := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/gateway/private" {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodPut {
			var body struct{ Private bool }
			_ = json.NewDecoder(r.Body).Decode(&body)
			private = body.Private
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"private": private})
	}))
	defer server.Close()
	original := computerClient
	computerClient = func(context.Context, io.Reader, io.Writer, bool) (*api.Client, error) {
		return api.New(server.URL), nil
	}
	t.Cleanup(func() { computerClient = original })

	for _, tc := range []struct{ args, want string }{
		{"private on", "Private mode is on: this computer's requests stay out of Activity.\n"},
		{"private", "Private mode is on: this computer's requests stay out of Activity.\n"},
		{"private off", "Private mode is off: this computer's requests show in Activity.\n"},
	} {
		var out bytes.Buffer
		cmd := newRootCmd("dev")
		cmd.SetOut(&out)
		cmd.SetArgs(strings.Fields(tc.args))
		if err := cmd.Execute(); err != nil || out.String() != tc.want {
			t.Fatalf("%s: %q, %v", tc.args, out.String(), err)
		}
	}
}

func TestPrivateModeDoesNotApplyToALocalGateway(t *testing.T) {
	if err := gateway.Save(gateway.Settings{Mode: gateway.ModeLocal, LocalKey: "local"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Save(gateway.Settings{Mode: gateway.ModeHosted}) })
	cmd := newRootCmd("dev")
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs([]string{"private", "on"})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "doesn't apply") {
		t.Fatal(err)
	}
}
