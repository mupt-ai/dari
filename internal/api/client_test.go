package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDoJSONSuccess(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.Method == http.MethodPost {
			_ = json.NewDecoder(r.Body).Decode(&gotBody)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"value":"hello"}`))
	}))
	defer srv.Close()

	c := New(srv.URL).WithBearer("tok-1")

	var resp struct {
		OK    bool   `json:"ok"`
		Value string `json:"value"`
	}
	if err := c.Do(context.Background(), http.MethodPost, "/v1/ping", map[string]string{"x": "y"}, &resp); err != nil {
		t.Fatalf("Do: %v", err)
	}
	if gotAuth != "Bearer tok-1" {
		t.Errorf("auth header: %q", gotAuth)
	}
	if gotBody["x"] != "y" {
		t.Errorf("body: %v", gotBody)
	}
	if !resp.OK || resp.Value != "hello" {
		t.Errorf("resp: %+v", resp)
	}
}

func TestDoHTTPErrorWithDetail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"detail":"token expired"}`))
	}))
	defer srv.Close()

	err := New(srv.URL).Do(context.Background(), http.MethodGet, "/v1/anything", nil, nil)
	he := AsHTTPError(err)
	if he == nil {
		t.Fatalf("expected HTTPError, got %T: %v", err, err)
	}
	if he.Status != 401 || he.Detail != "token expired" {
		t.Errorf("got %+v", he)
	}
}

func TestNormalizeURL(t *testing.T) {
	cases := map[string]string{
		"https://api.dari.dev":  "https://api.dari.dev",
		"https://api.dari.dev/": "https://api.dari.dev",
		"  https://x.com//  ":   "https://x.com",
	}
	for in, want := range cases {
		if got := NormalizeURL(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}
