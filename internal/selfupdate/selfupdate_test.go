package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"testing"
)

func TestNewClientDoesNotSetHTTPClientTimeout(t *testing.T) {
	client := NewClient("v1.2.3")
	if client.HTTPClient == nil {
		t.Fatal("HTTPClient is nil")
	}
	if client.HTTPClient.Timeout != 0 {
		t.Fatalf("HTTPClient.Timeout = %v, want no client-wide timeout", client.HTTPClient.Timeout)
	}
}

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"v1.2.3", "1.2.2", 1},
		{"1.2.3", "v1.2.3", 0},
		{"1.10.0", "1.9.9", 1},
		{"1.2.3", "1.2.4", -1},
		{"1.2.3", "1.2.3-beta.1", 1},
		{"1.2.3-beta.2", "1.2.3-beta.1", 1},
	}
	for _, tt := range tests {
		got := CompareVersions(tt.a, tt.b)
		if (got > 0) != (tt.want > 0) || (got < 0) != (tt.want < 0) {
			t.Errorf("CompareVersions(%q, %q) = %d, want sign %d", tt.a, tt.b, got, tt.want)
		}
	}
}

func TestReleaseAssetForPlatform(t *testing.T) {
	rel := Release{Assets: []Asset{
		{Name: "dari_1.2.3_linux_x86_64.tar.gz", URL: "linux-amd64"},
		{Name: "dari_1.2.3_macOS_arm64.tar.gz", URL: "darwin-arm64"},
		{Name: "dari_1.2.3_checksums.txt", URL: "checksums"},
	}}
	asset, err := rel.AssetForPlatform("darwin", "arm64")
	if err != nil {
		t.Fatalf("AssetForPlatform: %v", err)
	}
	if asset.URL != "darwin-arm64" {
		t.Fatalf("asset URL = %q", asset.URL)
	}
}

func TestChecksumForAsset(t *testing.T) {
	raw := []byte("abc123  dari_1.2.3_macOS_arm64.tar.gz\nffff  other.txt\n")
	got, ok := checksumForAsset(raw, "dari_1.2.3_macOS_arm64.tar.gz")
	if !ok || got != "abc123" {
		t.Fatalf("checksumForAsset = %q, %v", got, ok)
	}
}

func TestExtractDariBinary(t *testing.T) {
	archive := makeArchive(t, map[string]string{
		"README.md": "docs",
		"dari":      "binary contents",
	})
	got, mode, err := extractBinary(archive, "dari")
	if err != nil {
		t.Fatalf("extractBinary: %v", err)
	}
	if string(got) != "binary contents" {
		t.Fatalf("binary = %q", got)
	}
	if mode&0o111 == 0 {
		t.Fatalf("mode is not executable: %v", mode)
	}
}

func makeArchive(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		mode := int64(0o644)
		if name == "dari" {
			mode = 0o755
		}
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(body))}); err != nil {
			t.Fatalf("WriteHeader: %v", err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}
