package cli

import "testing"

func TestNormalizeRouterID(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    string
		wantErr bool
	}{
		{
			name: "raw ID",
			raw:  " rtr_123 ",
			want: "rtr_123",
		},
		{
			name: "router endpoint URL",
			raw:  "https://routing.dari.dev/rtr_123/chat/completions",
			want: "rtr_123",
		},
		{
			name: "router endpoint URL with query",
			raw:  "https://routing.dari.dev/rtr_123/chat/completions?stream=false",
			want: "rtr_123",
		},
		{
			name: "path copied without scheme",
			raw:  "routing.dari.dev/rtr_123/chat/completions",
			want: "rtr_123",
		},
		{
			name: "custom future ID without path syntax",
			raw:  "router-prod",
			want: "router-prod",
		},
		{
			name:    "URL without router ID",
			raw:     "https://routing.dari.dev/chat/completions",
			wantErr: true,
		},
		{
			name:    "path without router ID",
			raw:     "routing.dari.dev/chat/completions",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeRouterID(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("normalizeRouterID(%q) succeeded, want error", tt.raw)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeRouterID(%q): %v", tt.raw, err)
			}
			if got != tt.want {
				t.Fatalf("normalizeRouterID(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}
