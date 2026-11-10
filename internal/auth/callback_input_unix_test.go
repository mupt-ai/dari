//go:build darwin || linux

package auth

import (
	"context"
	"io"
	"os"
	"testing"
	"time"
)

func TestCallbackInputPreservesAgentInput(t *testing.T) {
	for _, browser := range []bool{true, false} {
		t.Run(map[bool]string{true: "browser", false: "paste"}[browser], func(t *testing.T) {
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			defer w.Close()
			cb := &callbackServer{result: make(chan CallbackResult, 1)}
			done := make(chan error, 1)
			go func() {
				got, err := cb.WaitOrInput(context.Background(), r, time.Second)
				if err == nil && got.Code != "abc" {
					t.Errorf("unexpected result: %+v", got)
				}
				done <- err
			}()
			if browser {
				if _, err := w.WriteString("\n \r\n"); err != nil {
					t.Fatal(err)
				}
				time.Sleep(50 * time.Millisecond)
				cb.result <- CallbackResult{Code: "abc", State: "state"}
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				if _, err := w.WriteString("agent input\n"); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := w.WriteString("http://127.0.0.1/callback?code=abc&state=state\nagent input\n"); err != nil {
					t.Fatal(err)
				}
				if err := <-done; err != nil {
					t.Fatal(err)
				}
			}
			w.Close()
			rest, err := io.ReadAll(r)
			if err != nil {
				t.Fatal(err)
			}
			if string(rest) != "agent input\n" {
				t.Fatalf("input stolen: %q", rest)
			}
		})
	}
}

func TestCallbackInputCancellation(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	cb := &callbackServer{result: make(chan CallbackResult, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cb.WaitOrInput(ctx, r, time.Second); err != context.Canceled {
		t.Fatalf("got %v", err)
	}
	if _, err := cb.WaitOrInput(context.Background(), r, time.Millisecond); err == nil {
		t.Fatal("expected timeout")
	}
}
