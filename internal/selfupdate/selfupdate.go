// Package selfupdate checks GitHub releases and replaces the running dari binary.
package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/state"
)

const (
	// ReleasesURL lists the releases of mupt-ai/dari, which carry the CLI and
	// the gateway binaries for each version.
	ReleasesURL      = "https://api.github.com/repos/mupt-ai/dari/releases"
	latestReleaseURL = ReleasesURL + "/latest"
	cacheFilename    = "update-check.json"
	maxDownloadBytes = 200 << 20 // 200 MiB
)

// Release describes the subset of GitHub release metadata used by updates.
type Release struct {
	Version string
	URL     string
	Assets  []Asset
}

// Asset is a downloadable release artifact.
type Asset struct {
	Name string
	URL  string
}

// CheckResult reports whether currentVersion is behind the latest GitHub release.
type CheckResult struct {
	CurrentVersion  string
	LatestVersion   string
	UpdateAvailable bool
	ReleaseURL      string
}

// UpdateOptions controls binary replacement. Zero values are suitable for the real CLI.
type UpdateOptions struct {
	TargetPath string
	Force      bool
	GOOS       string
	GOARCH     string
	Stdout     io.Writer
	Stderr     io.Writer
}

// UpdateResult describes the action taken by Update.
type UpdateResult struct {
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version"`
	Updated        bool   `json:"updated"`
	Method         string `json:"method"`
	Path           string `json:"path,omitempty"`
}

// Client talks to the GitHub Releases API.
type Client struct {
	HTTPClient *http.Client
	LatestURL  string
	UserAgent  string
}

// NewClient returns a release client that relies on per-operation context deadlines.
func NewClient(currentVersion string) *Client {
	uaVersion := strings.TrimSpace(currentVersion)
	if uaVersion == "" {
		uaVersion = "dev"
	}
	return &Client{
		HTTPClient: http.DefaultClient,
		LatestURL:  latestReleaseURL,
		UserAgent:  "dari-cli/" + uaVersion,
	}
}

// Latest fetches the latest non-prerelease GitHub release.
func (c *Client) Latest(ctx context.Context) (Release, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.LatestURL, nil)
	if err != nil {
		return Release{}, fmt.Errorf("build latest-release request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", c.UserAgent)

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return Release{}, fmt.Errorf("fetch latest release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return Release{}, fmt.Errorf("fetch latest release: %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}

	var gh struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&gh); err != nil {
		return Release{}, fmt.Errorf("decode latest release: %w", err)
	}
	assets := make([]Asset, 0, len(gh.Assets))
	if strings.TrimSpace(gh.TagName) == "" {
		return Release{}, errors.New("latest release response is missing tag_name")
	}
	for _, a := range gh.Assets {
		if a.Name != "" && a.BrowserDownloadURL != "" {
			assets = append(assets, Asset{Name: a.Name, URL: a.BrowserDownloadURL})
		}
	}
	return Release{Version: gh.TagName, URL: gh.HTMLURL, Assets: assets}, nil
}

// Check returns cached update information when it is fresh, otherwise it queries GitHub.
func Check(ctx context.Context, currentVersion string, maxAge time.Duration) (CheckResult, error) {
	result := CheckResult{CurrentVersion: currentVersion}
	if !IsReleaseVersion(currentVersion) {
		return result, nil
	}

	if cached, ok := readFreshCache(maxAge); ok {
		result.LatestVersion = cached.LatestVersion
		result.ReleaseURL = cached.ReleaseURL
		result.UpdateAvailable = IsNewerVersion(cached.LatestVersion, currentVersion)
		return result, nil
	}

	release, err := NewClient(currentVersion).Latest(ctx)
	if err != nil {
		if cached, ok := readAnyCache(); ok {
			result.LatestVersion = cached.LatestVersion
			result.ReleaseURL = cached.ReleaseURL
			result.UpdateAvailable = IsNewerVersion(cached.LatestVersion, currentVersion)
		}
		return result, err
	}
	_ = writeCache(updateCache{CheckedAt: time.Now().UTC(), LatestVersion: release.Version, ReleaseURL: release.URL})
	result.LatestVersion = release.Version
	result.ReleaseURL = release.URL
	result.UpdateAvailable = IsNewerVersion(release.Version, currentVersion)
	return result, nil
}

// Notice writes a one-line update warning to w when a newer release is available.
// Network/cache failures are intentionally ignored so normal commands never fail.
func Notice(ctx context.Context, w io.Writer, currentVersion string) {
	if w == nil || updateCheckDisabled() || !IsReleaseVersion(currentVersion) {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
	defer cancel()
	res, err := Check(ctx, currentVersion, 24*time.Hour)
	if err != nil && !res.UpdateAvailable {
		return
	}
	if res.UpdateAvailable {
		_, _ = fmt.Fprintf(w, "A newer dari CLI is available: %s (you have %s). Run `dari update` to upgrade.\n\n", displayVersion(res.LatestVersion), displayVersion(currentVersion))
	}
}

// Update installs the latest release if it is newer than currentVersion.
func Update(ctx context.Context, currentVersion string, opts UpdateOptions) (UpdateResult, error) {
	if !IsReleaseVersion(currentVersion) {
		return UpdateResult{CurrentVersion: currentVersion}, errors.New("cannot self-update an unversioned dev build")
	}

	client := NewClient(currentVersion)
	release, err := client.Latest(ctx)
	if err != nil {
		return UpdateResult{}, err
	}
	result := UpdateResult{
		CurrentVersion: currentVersion,
		LatestVersion:  release.Version,
		Method:         "binary",
	}
	if !opts.Force && !IsNewerVersion(release.Version, currentVersion) {
		return result, nil
	}

	target, err := resolveTargetPath(opts.TargetPath)
	if err != nil {
		return result, err
	}
	result.Path = target

	goos, goarch := opts.GOOS, opts.GOARCH
	if goos == "" {
		goos = runtime.GOOS
	}
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	asset, err := release.AssetForPlatform(goos, goarch)
	if err != nil {
		return result, err
	}
	data, err := client.download(ctx, asset.URL)
	if err != nil {
		return result, fmt.Errorf("download %s: %w", asset.Name, err)
	}
	if err := client.verifyChecksum(ctx, release, asset, data); err != nil {
		return result, err
	}
	binary, mode, err := extractBinary(data, "dari")
	if err != nil {
		return result, err
	}
	if err := replaceExecutable(target, binary, mode); err != nil {
		return result, err
	}
	_ = writeCache(updateCache{CheckedAt: time.Now().UTC(), LatestVersion: release.Version, ReleaseURL: release.URL})
	result.Updated = true
	return result, nil
}

// Install installs project from the GitHub release at releaseURL, which has
// GoReleaser-style archives and checksums, to target. It returns the
// installed release version.
func Install(ctx context.Context, cliVersion, releaseURL, project, target string) (string, error) {
	client := NewClient(cliVersion)
	client.LatestURL = releaseURL
	release, err := client.Latest(ctx)
	if err != nil {
		return "", err
	}
	asset, err := release.archiveFor(project, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	data, err := client.download(ctx, asset.URL)
	if err != nil {
		return "", fmt.Errorf("download %s: %w", asset.Name, err)
	}
	if err := client.verifyChecksum(ctx, release, asset, data); err != nil {
		return "", err
	}
	binary, mode, err := extractBinary(data, project)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := replaceExecutable(target, binary, mode); err != nil {
		return "", err
	}
	return release.Version, nil
}

// AssetForPlatform selects the GoReleaser archive for a GOOS/GOARCH pair.
func (r Release) AssetForPlatform(goos, goarch string) (Asset, error) {
	return r.archiveFor("dari", goos, goarch)
}

// archiveFor selects project's archive, named
// <project>_<version>_<macOS|linux>_<x86_64|arm64>.tar.gz, for a platform.
func (r Release) archiveFor(project, goos, goarch string) (Asset, error) {
	osName, err := archiveOSName(goos)
	if err != nil {
		return Asset{}, err
	}
	archName, err := archiveArchName(goarch)
	if err != nil {
		return Asset{}, err
	}
	suffix := "_" + osName + "_" + archName + ".tar.gz"
	for _, asset := range r.Assets {
		if strings.HasPrefix(asset.Name, project+"_") && strings.HasSuffix(asset.Name, suffix) {
			return asset, nil
		}
	}
	return Asset{}, fmt.Errorf("no release asset for %s/%s", goos, goarch)
}

// IsReleaseVersion reports whether v looks like a tagged release version.
func IsReleaseVersion(v string) bool {
	_, ok := parseVersion(v)
	return ok
}

// IsNewerVersion reports whether latest is semantically newer than current.
func IsNewerVersion(latest, current string) bool {
	return CompareVersions(latest, current) > 0
}

// CompareVersions compares semantic versions, accepting an optional leading v.
func CompareVersions(a, b string) int {
	av, aok := parseVersion(a)
	bv, bok := parseVersion(b)
	if !aok || !bok {
		return strings.Compare(strings.TrimSpace(a), strings.TrimSpace(b))
	}
	for i := 0; i < 3; i++ {
		if av.core[i] > bv.core[i] {
			return 1
		}
		if av.core[i] < bv.core[i] {
			return -1
		}
	}
	// A release version sorts after a prerelease with the same core.
	if av.pre == "" && bv.pre != "" {
		return 1
	}
	if av.pre != "" && bv.pre == "" {
		return -1
	}
	return strings.Compare(av.pre, bv.pre)
}

func (c *Client) download(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.UserAgent)
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxDownloadBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxDownloadBytes {
		return nil, errors.New("download exceeds maximum size")
	}
	return data, nil
}

func (c *Client) verifyChecksum(ctx context.Context, release Release, asset Asset, data []byte) error {
	checksumAsset, ok := release.checksumAsset(asset.Name)
	if !ok {
		return errors.New("release is missing checksum asset")
	}
	raw, err := c.download(ctx, checksumAsset.URL)
	if err != nil {
		return fmt.Errorf("download %s: %w", checksumAsset.Name, err)
	}
	want, ok := checksumForAsset(raw, asset.Name)
	if !ok {
		return fmt.Errorf("checksum file does not contain %s", asset.Name)
	}
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("checksum mismatch for %s", asset.Name)
	}
	return nil
}

// checksumAsset finds the checksum file for archive: the one named for the
// archive's project (`dari_`, `dari-gateway_`) when there is one, else the
// release's only checksum file, which lists the CLI and gateway archives.
func (r Release) checksumAsset(archive string) (Asset, bool) {
	project, _, _ := strings.Cut(archive, "_")
	var shared []Asset
	for _, asset := range r.Assets {
		if !strings.HasSuffix(asset.Name, "_checksums.txt") {
			continue
		}
		if strings.HasPrefix(asset.Name, project+"_") {
			return asset, true
		}
		shared = append(shared, asset)
	}
	if len(shared) == 1 {
		return shared[0], true
	}
	return Asset{}, false
}

func checksumForAsset(raw []byte, assetName string) (string, bool) {
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := strings.TrimPrefix(fields[len(fields)-1], "*")
		if filepath.Base(name) == assetName {
			return fields[0], true
		}
	}
	return "", false
}

// extractBinary returns the executable named name from a release archive.
func extractBinary(archive []byte, name string) ([]byte, os.FileMode, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, 0, fmt.Errorf("open release archive: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, 0, fmt.Errorf("read release archive: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		base := filepath.Base(hdr.Name)
		if base != name && base != name+".exe" {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(tr, maxDownloadBytes+1))
		if err != nil {
			return nil, 0, fmt.Errorf("read %s binary from archive: %w", name, err)
		}
		if len(data) > maxDownloadBytes {
			return nil, 0, fmt.Errorf("%s binary exceeds maximum size", name)
		}
		mode := hdr.FileInfo().Mode().Perm()
		if mode&0o111 == 0 {
			mode = 0o755
		}
		return data, mode, nil
	}
	return nil, 0, fmt.Errorf("release archive does not contain a %s binary", name)
}

// replaceExecutable writes binary to target atomically, keeping an existing
// target's permissions.
func replaceExecutable(target string, binary []byte, mode os.FileMode) error {
	if info, err := os.Stat(target); err == nil && info.Mode().Perm()&0o111 != 0 {
		mode = info.Mode().Perm()
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat current executable: %w", err)
	}
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".dari-update-*")
	if err != nil {
		return fmt.Errorf("create temporary executable: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if _, err := tmp.Write(binary); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temporary executable: %w", err)
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod temporary executable: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary executable: %w", err)
	}
	if err := os.Rename(tmpPath, target); err != nil {
		return fmt.Errorf("replace executable: %w", err)
	}
	return nil
}

func resolveTargetPath(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		exe, err := os.Executable()
		if err != nil {
			return "", fmt.Errorf("resolve current executable: %w", err)
		}
		path = exe
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	return path, nil
}

type parsedVersion struct {
	core [3]int
	pre  string
}

func parseVersion(raw string) (parsedVersion, bool) {
	v := strings.TrimSpace(raw)
	if v == "" || v == "dev" {
		return parsedVersion{}, false
	}
	v = strings.TrimPrefix(v, "v")
	if plus := strings.IndexByte(v, '+'); plus >= 0 {
		v = v[:plus]
	}
	pre := ""
	if dash := strings.IndexByte(v, '-'); dash >= 0 {
		pre = v[dash+1:]
		v = v[:dash]
	}
	parts := strings.Split(v, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return parsedVersion{}, false
	}
	var out parsedVersion
	out.pre = pre
	for i, p := range parts {
		if p == "" {
			return parsedVersion{}, false
		}
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return parsedVersion{}, false
		}
		out.core[i] = n
	}
	return out, true
}

func archiveOSName(goos string) (string, error) {
	switch goos {
	case "darwin":
		return "macOS", nil
	case "linux":
		return "linux", nil
	default:
		return "", fmt.Errorf("Dari releases are not published for %s", goos)
	}
}

func archiveArchName(goarch string) (string, error) {
	switch goarch {
	case "amd64":
		return "x86_64", nil
	case "arm64":
		return "arm64", nil
	default:
		return "", fmt.Errorf("Dari releases are not published for %s", goarch)
	}
}

func displayVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || strings.HasPrefix(v, "v") {
		return v
	}
	if _, ok := parseVersion(v); ok {
		return "v" + v
	}
	return v
}

func updateCheckDisabled() bool {
	for _, name := range []string{"DARI_DISABLE_UPDATE_CHECK", "DARI_NO_UPDATE_CHECK"} {
		v := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
		if v == "1" || v == "true" || v == "yes" {
			return true
		}
	}
	return false
}

type updateCache struct {
	CheckedAt     time.Time `json:"checked_at"`
	LatestVersion string    `json:"latest_version"`
	ReleaseURL    string    `json:"release_url,omitempty"`
}

func readFreshCache(maxAge time.Duration) (updateCache, bool) {
	cache, ok := readAnyCache()
	if !ok || maxAge <= 0 || cache.CheckedAt.IsZero() {
		return updateCache{}, false
	}
	if time.Since(cache.CheckedAt) > maxAge {
		return updateCache{}, false
	}
	return cache, true
}

func readAnyCache() (updateCache, bool) {
	path, err := cachePath()
	if err != nil {
		return updateCache{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return updateCache{}, false
	}
	var cache updateCache
	if err := json.Unmarshal(data, &cache); err != nil || cache.LatestVersion == "" {
		return updateCache{}, false
	}
	return cache, true
}

func writeCache(cache updateCache) error {
	path, err := cachePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return err
	}
	perm := os.FileMode(0o644)
	if runtime.GOOS != "windows" {
		perm = 0o600
	}
	return os.WriteFile(path, data, perm)
}

func cachePath() (string, error) {
	statePath, err := state.Path()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(statePath), cacheFilename), nil
}
