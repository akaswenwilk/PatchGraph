package projects

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const RootEnvVar = "PATCHGRAPH_PROJECTS_ROOT"

var ErrRootNotConfigured = errors.New("PATCHGRAPH_PROJECTS_ROOT is not configured")

type Project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`

	absPath string
}

func RootFromEnv() (string, error) {
	root := strings.TrimSpace(os.Getenv(RootEnvVar))
	if root == "" {
		return "", ErrRootNotConfigured
	}

	return filepath.Clean(root), nil
}

func Discover(root string) ([]Project, error) {
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("projects root must be a directory")
	}

	projectList := make([]Project, 0)

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

		relPath, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}

		cleanRelPath := filepath.ToSlash(relPath)
		projectList = append(projectList, Project{
			ID:      projectID(path),
			Name:    filepath.Base(path),
			Path:    cleanRelPath,
			absPath: path,
		})

		return filepath.SkipDir
	})
	if err != nil {
		return nil, err
	}

	sort.Slice(projectList, func(left, right int) bool {
		if projectList[left].Name != projectList[right].Name {
			return projectList[left].Name < projectList[right].Name
		}

		return projectList[left].Path < projectList[right].Path
	})

	return projectList, nil
}

func FindByID(root string, id string) (Project, error) {
	projects, err := Discover(root)
	if err != nil {
		return Project{}, err
	}

	for _, project := range projects {
		if project.ID == id {
			return project, nil
		}
	}

	return Project{}, fs.ErrNotExist
}

func (project Project) AbsolutePath() string {
	return project.absPath
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

func projectID(path string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(path)))
	return hex.EncodeToString(sum[:8])
}
