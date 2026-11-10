package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoutingRequestCosts(t *testing.T) {
	id := "35fcb4c6-5902-40a7-adfe-e9289cab6855"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/request-costs" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer same-key" {
			t.Errorf("unexpected pricing request: %s %s", r.Method, r.URL.Path)
		}
		var body struct {
			IDs []string `json:"request_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.IDs) != 1 || body.IDs[0] != id {
			t.Errorf("invalid request IDs: %+v, %v", body, err)
		}
		_, _ = w.Write([]byte(`{"data":[{"model_cost_usd":"0.12"}]}`))
	}))
	defer server.Close()
	data, err := fetchRoutingRequestCosts(context.Background(), server.URL, "same-key", []string{id})
	if err != nil || !json.Valid(data) {
		t.Fatalf("pricing response: %s, %v", data, err)
	}
	cmd := newRouterRequestCostsCmd()
	if err := cmd.Args(cmd, []string{"bad-id"}); err == nil {
		t.Fatal("invalid UUID accepted")
	}
}

func TestRoutingRequestCostsRejectsRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer server.Close()
	if _, err := fetchRoutingRequestCosts(context.Background(), server.URL, "key", []string{"id"}); err == nil {
		t.Fatal("redirect accepted")
	}
}
