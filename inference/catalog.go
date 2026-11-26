// Package inference exposes the shipped engine manifests to the launcher without
// requiring Python, model weights, or a running server on the launching machine.
package inference

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"sort"
)

//go:embed dari_engine/engines/*/models.json
var manifests embed.FS

func ModelNames() ([]string, error) {
	paths, err := fs.Glob(manifests, "dari_engine/engines/*/models.json")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var names []string
	for _, path := range paths {
		data, err := manifests.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var entries map[string]json.RawMessage
		if err := json.Unmarshal(data, &entries); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		for name := range entries {
			if seen[name] {
				return nil, fmt.Errorf("duplicate local model: %s", name)
			}
			seen[name] = true
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}
