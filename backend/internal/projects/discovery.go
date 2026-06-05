package projects

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

const projectsRootEnv = "PATCHGRAPH_PROJECTS_ROOT"

func DiscoverNamesFromEnv() ([]string, error) {
	root := os.Getenv(projectsRootEnv)
	if root == "" {
		return []string{}, nil
	}

	return DiscoverNames(root)
}

func DiscoverNames(root string) ([]string, error) {
	info, err := os.Stat(root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []string{}, nil
		}

		return nil, err
	}

	if !info.IsDir() {
		return nil, errors.New(projectsRootEnv + " must point to a directory")
	}

	seen := make(map[string]struct{})
	var names []string

	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		if !d.IsDir() {
			return nil
		}

		if path == root {
			return nil
		}

		markerInfo, err := os.Stat(filepath.Join(path, ".git"))
		if err == nil && markerInfo.IsDir() {
			name := filepath.Base(path)
			if _, ok := seen[name]; !ok {
				seen[name] = struct{}{}
				names = append(names, name)
			}

			return filepath.SkipDir
		}

		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Strings(names)
	return names, nil
}
