package projects

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const RootEnvVar = "PATCHGRAPH_PROJECTS_ROOT"

var ErrRootNotConfigured = errors.New("PATCHGRAPH_PROJECTS_ROOT is not configured")

func RootFromEnv() (string, error) {
	root := strings.TrimSpace(os.Getenv(RootEnvVar))
	if root == "" {
		return "", ErrRootNotConfigured
	}

	return filepath.Clean(root), nil
}

func Discover(root string) ([]string, error) {
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("projects root must be a directory")
	}

	seen := make(map[string]struct{})
	projects := make([]string, 0)

	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		if path == root {
			return nil
		}

		isRepo, err := isProjectDirectory(path)
		if err != nil {
			return err
		}
		if !isRepo {
			return nil
		}

		name := filepath.Base(path)
		if _, exists := seen[name]; !exists {
			seen[name] = struct{}{}
			projects = append(projects, name)
		}

		return filepath.SkipDir
	})
	if err != nil {
		return nil, err
	}

	sort.Strings(projects)
	return projects, nil
}

func isProjectDirectory(path string) (bool, error) {
	_, err := os.Stat(filepath.Join(path, ".git"))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}

	return false, err
}
