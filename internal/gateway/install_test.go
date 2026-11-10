package gateway

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// releaseServer serves one GitHub-style release of the gateway at version,
// counting the archive downloads; fail makes the archive unavailable.
func releaseServer(t *testing.T, version string, fail bool) (*int, func()) {
	t.Helper()
	osName := map[string]string{"darwin": "macOS", "linux": "linux"}[runtime.GOOS]
	arch := map[string]string{"amd64": "x86_64", "arm64": "arm64"}[runtime.GOARCH]
	if osName == "" || arch == "" {
		t.Skip("no gateway release for this platform")
	}
	archiveName := fmt.Sprintf("dari-gateway_%s_%s_%s.tar.gz", version, osName, arch)
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	body := []byte("#!/bin/sh\necho gateway " + version + "\n")
	_ = tw.WriteHeader(&tar.Header{Name: "dari-gateway", Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(body)
	_ = tw.Close()
	_ = gz.Close()
	sum := sha256.Sum256(archive.Bytes())
	downloads := 0

	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	mux.HandleFunc("/tags/v"+version, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v" + version,
			"html_url": server.URL,
			"assets": []map[string]string{
				{"name": archiveName, "browser_download_url": server.URL + "/archive"},
				{"name": "dari_" + version + "_checksums.txt", "browser_download_url": server.URL + "/sums"},
			},
		})
	})
	mux.HandleFunc("/archive", func(w http.ResponseWriter, _ *http.Request) {
		downloads++
		if fail {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write(archive.Bytes())
	})
	mux.HandleFunc("/sums", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "%s  %s\n", hex.EncodeToString(sum[:]), archiveName)
	})
	previous := releasesURL
	releasesURL = server.URL
	return &downloads, func() {
		releasesURL = previous
		server.Close()
	}
}

// installedGateway puts a gateway binary in place, recording version when it
// is not empty, as an install before version recording would leave none.
func installedGateway(t *testing.T, version string) localPaths {
	t.Helper()
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
	p, err := paths()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(p.binary), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.binary, []byte("#!/bin/sh\necho old\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if version != "" {
		if err := os.WriteFile(versionPath(p), []byte(version), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

// After `dari update`, the next launch replaces a gateway on another version
// (or one whose version was never recorded) with the CLI's own.
func TestEnsureInstalledUpdatesToTheCLIVersion(t *testing.T) {
	for _, installed := range []string{"", "1.0.290"} {
		t.Run("installed="+installed, func(t *testing.T) {
			p := installedGateway(t, installed)
			downloads, stop := releaseServer(t, "1.0.291", false)
			defer stop()

			var progress []string
			updated, err := ensureInstalled(context.Background(), "1.0.291", func(line string) { progress = append(progress, line) })
			if err != nil || !updated || *downloads != 1 {
				t.Fatalf("updated=%v err=%v downloads=%d", updated, err, *downloads)
			}
			if InstalledVersion() != "1.0.291" {
				t.Errorf("recorded version = %q", InstalledVersion())
			}
			if binary, _ := os.ReadFile(p.binary); !strings.Contains(string(binary), "gateway 1.0.291") {
				t.Errorf("binary not replaced: %q", binary)
			}
			if !strings.Contains(strings.Join(progress, "\n"), "Updating Dari Gateway to v1.0.291") {
				t.Errorf("progress = %q", progress)
			}
		})
	}
}

// A gateway already on the CLI's version, or a development CLI, downloads
// nothing.
func TestEnsureInstalledKeepsAMatchingGateway(t *testing.T) {
	for _, tc := range []struct{ installed, cli string }{{"1.0.291", "1.0.291"}, {"1.0.291", "v1.0.291"}, {"1.0.290", "dev"}} {
		installedGateway(t, tc.installed)
		downloads, stop := releaseServer(t, "1.0.291", false)
		updated, err := ensureInstalled(context.Background(), tc.cli, func(string) {})
		stop()
		if err != nil || updated || *downloads != 0 {
			t.Errorf("installed=%s cli=%s: updated=%v err=%v downloads=%d", tc.installed, tc.cli, updated, err, *downloads)
		}
	}
}

// Offline, or with the release unavailable, the launch goes on with the
// installed gateway.
func TestEnsureInstalledKeepsTheGatewayWhenTheUpdateFails(t *testing.T) {
	p := installedGateway(t, "1.0.290")
	_, stop := releaseServer(t, "1.0.291", true)
	defer stop()

	var progress []string
	updated, err := ensureInstalled(context.Background(), "1.0.291", func(line string) { progress = append(progress, line) })
	if err != nil || updated {
		t.Fatalf("updated=%v err=%v", updated, err)
	}
	if InstalledVersion() != "1.0.290" {
		t.Errorf("recorded version = %q", InstalledVersion())
	}
	if binary, _ := os.ReadFile(p.binary); !strings.Contains(string(binary), "echo old") {
		t.Errorf("binary changed: %q", binary)
	}
	if !strings.Contains(strings.Join(progress, "\n"), "Could not update Dari Gateway") {
		t.Errorf("progress = %q", progress)
	}
}

// A serving gateway restarts on the installed binary when it runs another
// version, or one recorded before versions were; never on an unknown install.
func TestRunsOldBinary(t *testing.T) {
	for _, tc := range []struct {
		installed, running string
		want               bool
	}{
		{"1.0.291", "1.0.291", false},
		{"1.0.291", "1.0.290", true},
		{"1.0.291", "", true},
		{"", "1.0.290", false},
		{"", "", false},
	} {
		if got := runsOldBinary(tc.installed, tc.running); got != tc.want {
			t.Errorf("runsOldBinary(%q, %q) = %v, want %v", tc.installed, tc.running, got, tc.want)
		}
	}
}

// Starting records the installed version as the serving one; stopping, or
// finding the recorded process gone, forgets it.
func TestRunningVersionFollowsTheProcess(t *testing.T) {
	process := fakeGateway(t)
	p, _ := paths()
	if err := os.WriteFile(versionPath(p), []byte("1.0.291"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := MarkRunning(); err != nil {
		t.Fatal(err)
	}
	if RunningVersion() != "1.0.291" {
		t.Fatalf("running = %q", RunningVersion())
	}
	if stopped, err := Stop(context.Background()); err != nil || !stopped {
		t.Fatalf("stop = %v, %v", stopped, err)
	}
	if RunningVersion() != "" {
		t.Fatalf("running after stop = %q", RunningVersion())
	}
	_ = process
}
