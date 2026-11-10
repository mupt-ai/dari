package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestEvalCreateSendsCSVPayload(t *testing.T) {
	csvPath := writeEvalCSV(t, `model_id,score,thinking_level,notes,metadata_json
openai/gpt-5.6-sol,87.5,HIGH,Strong run,"{""sample_count"":120}"
anthropic/claude-fable-5,81,,,
`)
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/v1/organizations/current/evals" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer dari_test" {
			t.Fatalf("Authorization = %q", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "evl_123"})
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetArgs([]string{
		"--api-url", srv.URL,
		"eval", "create",
		"--name", " SWE-bench Verified ",
		"--description", " Public benchmark scores. ",
		"--min-score", "-10",
		"--max-score", "110",
		"--file", csvPath,
	})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari eval create: %v", err)
	}

	want := map[string]any{
		"name":        "SWE-bench Verified",
		"description": "Public benchmark scores.",
		"min_score":   float64(-10),
		"max_score":   float64(110),
		"scores": []any{
			map[string]any{
				"model_id":       "openai/gpt-5.6-sol",
				"score":          87.5,
				"thinking_level": "high",
				"notes":          "Strong run",
				"metadata_json": map[string]any{
					"sample_count": float64(120),
				},
			},
			map[string]any{
				"model_id": "anthropic/claude-fable-5",
				"score":    float64(81),
			},
		},
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("create body = %#v, want %#v", body, want)
	}
}

func TestEvalCreateReadsCSVFromStdin(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"id":"evl_stdin"}`)
	}))
	defer srv.Close()
	useTestAPIKey(t)

	cmd := newRootCmd("dev")
	cmd.SetIn(strings.NewReader("model_id,score,notes\nopenai/gpt-5.6-sol,92,stdin row\n"))
	cmd.SetArgs([]string{
		"--api-url", srv.URL,
		"eval", "create",
		"--name", "Stdin Eval",
		"--file", "-",
	})
	if err := captureStdout(t, func() error { return cmd.Execute() }); err != nil {
		t.Fatalf("dari eval create: %v", err)
	}

	want := map[string]any{
		"name":        "Stdin Eval",
		"description": nil,
		"min_score":   float64(0),
		"max_score":   float64(100),
		"scores": []any{
			map[string]any{
				"model_id": "openai/gpt-5.6-sol",
				"score":    float64(92),
				"notes":    "stdin row",
			},
		},
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("create body = %#v, want %#v", body, want)
	}
}

func TestEvalCreateRejectsInvalidCSVBeforeRequest(t *testing.T) {
	tests := []struct {
		name    string
		content string
		wantErr string
	}{
		{
			name:    "wrong header",
			content: "score,model_id\n80,openai/gpt-5.6-sol\n",
			wantErr: "CSV header must be model_id,score",
		},
		{
			name:    "malformed CSV",
			content: "model_id,score,notes\nopenai/gpt-5.6-sol,80,\"unterminated\n",
			wantErr: "CSV row 2",
		},
		{
			name:    "invalid score",
			content: "model_id,score\nopenai/gpt-5.6-sol,not-a-number\n",
			wantErr: `CSV row 2 has invalid score "not-a-number"`,
		},
		{
			name: "duplicate model and thinking level",
			content: `model_id,score,thinking_level
openai/gpt-5.6-sol,80,high
openai/gpt-5.6-sol,81,HIGH
`,
			wantErr: `CSV row 3 duplicates model_id "openai/gpt-5.6-sol" at thinking_level "high" from row 2`,
		},
		{
			name:    "metadata JSON is not an object",
			content: "model_id,score,metadata_json\nopenai/gpt-5.6-sol,80,[]\n",
			wantErr: "CSV row 2 metadata_json must be a JSON object",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requests := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				w.WriteHeader(http.StatusCreated)
			}))
			defer srv.Close()
			useTestAPIKey(t)
			csvPath := writeEvalCSV(t, tt.content)

			cmd := newRootCmd("dev")
			cmd.SetErr(io.Discard)
			cmd.SetArgs([]string{
				"--api-url", srv.URL,
				"eval", "create",
				"--name", "Invalid Eval",
				"--file", csvPath,
			})
			err := captureStdout(t, func() error { return cmd.Execute() })
			if err == nil {
				t.Fatal("dari eval create succeeded")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %q, want substring %q", err, tt.wantErr)
			}
			if requests != 0 {
				t.Fatalf("API received %d requests, want 0", requests)
			}
		})
	}
}

func TestEvalCreateValidatesScoreRangeBeforeRequest(t *testing.T) {
	t.Run("min-score must be less than max-score", func(t *testing.T) {
		requests := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests++
			w.WriteHeader(http.StatusCreated)
		}))
		defer srv.Close()
		useTestAPIKey(t)
		csvPath := writeEvalCSV(t, "model_id,score\nopenai/gpt-5.6-sol,80\n")

		cmd := newRootCmd("dev")
		cmd.SetErr(io.Discard)
		cmd.SetArgs([]string{
			"--api-url", srv.URL,
			"eval", "create",
			"--name", "Invalid Range",
			"--min-score", "100",
			"--max-score", "100",
			"--file", csvPath,
		})
		err := captureStdout(t, func() error { return cmd.Execute() })
		if err == nil || !strings.Contains(err.Error(), "min-score must be less than max-score") {
			t.Fatalf("error = %v", err)
		}
		if requests != 0 {
			t.Fatalf("API received %d requests, want 0", requests)
		}
	})

	t.Run("score outside configured range", func(t *testing.T) {
		requests := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests++
			w.WriteHeader(http.StatusCreated)
		}))
		defer srv.Close()
		useTestAPIKey(t)
		csvPath := writeEvalCSV(t, "model_id,score\nopenai/gpt-5.6-sol,120\n")

		cmd := newRootCmd("dev")
		cmd.SetErr(io.Discard)
		cmd.SetArgs([]string{
			"--api-url", srv.URL,
			"eval", "create",
			"--name", "Score Out Of Range",
			"--min-score", "0",
			"--max-score", "100",
			"--file", csvPath,
		})
		err := captureStdout(t, func() error { return cmd.Execute() })
		if err == nil || !strings.Contains(err.Error(), "score 120 for model_id \"openai/gpt-5.6-sol\" must be between 0 and 100") {
			t.Fatalf("error = %v", err)
		}
		if requests != 0 {
			t.Fatalf("API received %d requests, want 0", requests)
		}
	})
}

func TestEvalCreateReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = io.WriteString(w, `{"detail":"Eval score is outside the configured range"}`)
	}))
	defer srv.Close()
	useTestAPIKey(t)
	csvPath := writeEvalCSV(t, "model_id,score\nopenai/gpt-5.6-sol,80\n")

	cmd := newRootCmd("dev")
	cmd.SetErr(io.Discard)
	cmd.SetArgs([]string{
		"--api-url", srv.URL,
		"eval", "create",
		"--name", "API Error",
		"--file", csvPath,
	})
	err := captureStdout(t, func() error { return cmd.Execute() })
	if err == nil {
		t.Fatal("dari eval create succeeded")
	}
	if !strings.Contains(err.Error(), "Eval score is outside the configured range") {
		t.Fatalf("error = %q", err)
	}
}

func writeEvalCSV(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "scores.csv")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
