package cli

import "testing"

func useTestAPIKey(t *testing.T) {
	t.Helper()
	t.Setenv("DARI_API_KEY", "dari_test")
	t.Setenv("DARI_CONFIG_DIR", t.TempDir())
}
