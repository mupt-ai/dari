package state

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
)

func TestRoutingKeyRoundTripAndScopeIsolation(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DARI_CONFIG_DIR", dir)
	unsetXDG(t)

	for scope, want := range map[string]string{
		"api|org:one": "dari_one",
		"api|org:two": "dari_two",
	} {
		got, created, err := EnsureRoutingKey(scope, func() (string, error) { return want, nil })
		if err != nil {
			t.Fatal(err)
		}
		if got != want || !created {
			t.Errorf("EnsureRoutingKey(%q) = %q, %v", scope, got, created)
		}
		got, created, err = EnsureRoutingKey(scope, func() (string, error) {
			t.Fatal("cached key was issued again")
			return "", nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if got != want || created {
			t.Errorf("cached EnsureRoutingKey(%q) = %q, %v", scope, got, created)
		}
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dir, agentKeysFilename))
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Errorf("permissions = %o, want 600", got)
		}
	}
}

func TestConcurrentRoutingKeyCreationIssuesOnce(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DARI_CONFIG_DIR", dir)
	unsetXDG(t)

	var issues atomic.Int32
	var wg sync.WaitGroup
	errs := make(chan error, 10)
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			key, _, err := EnsureRoutingKey("scope", func() (string, error) {
				issues.Add(1)
				return "dari_secret", nil
			})
			if err == nil && key != "dari_secret" {
				t.Errorf("key = %q", key)
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := issues.Load(); got != 1 {
		t.Fatalf("key issues = %d, want 1", got)
	}
}

func TestRoutingKeysStaySeparateFromLoginState(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DARI_CONFIG_DIR", dir)
	unsetXDG(t)

	if err := Save(&CliState{
		APIURL:        "https://api.example.test",
		Organizations: map[string]Organization{},
	}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(dir, Filename))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := EnsureRoutingKey("scope", func() (string, error) { return "dari_secret", nil }); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(filepath.Join(dir, Filename))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("saving a Routing key changed login state")
	}
}
