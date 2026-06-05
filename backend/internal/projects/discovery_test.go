package projects

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestRootFromEnv(t *testing.T) {
	t.Setenv(RootEnvVar, "/tmp/projects")

	root, err := RootFromEnv()
	if err != nil {
		t.Fatalf("RootFromEnv() error = %v", err)
	}

	if root != "/tmp/projects" {
		t.Fatalf("RootFromEnv() = %q, want %q", root, "/tmp/projects")
	}
}

func TestRootFromEnvMissing(t *testing.T) {
	t.Setenv(RootEnvVar, "")

	_, err := RootFromEnv()
	if err == nil {
		t.Fatal("RootFromEnv() error = nil, want error")
	}
	if !errors.Is(err, ErrRootNotConfigured) {
		t.Fatalf("RootFromEnv() error = %v, want %v", err, ErrRootNotConfigured)
	}
}

func TestDiscoverFindsNestedProjects(t *testing.T) {
	root := t.TempDir()

	alphaPath := filepath.Join(root, "alpha")
	betaPath := filepath.Join(root, "group", "beta")
	workspacePath := filepath.Join(root, "workspace")
	createGitDir(t, alphaPath)
	createGitDir(t, betaPath)
	createGitFile(t, workspacePath)
	createGitDir(t, filepath.Join(workspacePath, "nested-ignored"))
	mustMkdirAll(t, filepath.Join(root, "notes"))

	projectList, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}

	if len(projectList) != 3 {
		t.Fatalf("len(projects) = %d, want 3; got %v", len(projectList), projectList)
	}

	assertProject(t, projectList[0], filepath.Base(alphaPath), "alpha", alphaPath)
	assertProject(t, projectList[1], filepath.Base(betaPath), "group/beta", betaPath)
	assertProject(t, projectList[2], filepath.Base(workspacePath), "workspace", workspacePath)
}

func TestDiscoverPreservesDuplicateNamesWithDistinctIDs(t *testing.T) {
	root := t.TempDir()

	projectAPath := filepath.Join(root, "team-a", "PatchGraph")
	projectBPath := filepath.Join(root, "team-b", "PatchGraph")
	createGitDir(t, projectAPath)
	createGitDir(t, projectBPath)

	projectList, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}

	if len(projectList) != 2 {
		t.Fatalf("len(projects) = %d, want 2; got %v", len(projectList), projectList)
	}
	if projectList[0].Name != "PatchGraph" || projectList[1].Name != "PatchGraph" {
		t.Fatalf("project names = %v, want duplicate PatchGraph entries", projectList)
	}
	if projectList[0].ID == projectList[1].ID {
		t.Fatalf("project IDs should differ for distinct paths: %v", projectList)
	}
}

func TestFindByID(t *testing.T) {
	root := t.TempDir()
	projectPath := filepath.Join(root, "PatchGraph")
	createGitDir(t, projectPath)

	projectList, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}

	project, err := FindByID(root, projectList[0].ID)
	if err != nil {
		t.Fatalf("FindByID() error = %v", err)
	}

	assertProject(t, project, "PatchGraph", "PatchGraph", projectPath)
}

func TestFindByIDMissing(t *testing.T) {
	root := t.TempDir()
	createGitDir(t, filepath.Join(root, "PatchGraph"))

	_, err := FindByID(root, "missing")
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("FindByID() error = %v, want %v", err, fs.ErrNotExist)
	}
}

func TestDiscoverRejectsNonDirectoryRoot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "projects.txt")
	if err := os.WriteFile(file, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	_, err := Discover(file)
	if err == nil {
		t.Fatal("Discover() error = nil, want error")
	}
}

func createGitDir(t *testing.T, dir string) {
	t.Helper()
	mustMkdirAll(t, filepath.Join(dir, ".git"))
}

func createGitFile(t *testing.T, dir string) {
	t.Helper()
	mustMkdirAll(t, dir)
	gitFile := filepath.Join(dir, ".git")
	if err := os.WriteFile(gitFile, []byte("gitdir: /tmp/worktree"), 0o644); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", gitFile, err)
	}
}

func mustMkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", dir, err)
	}
}

func assertProject(t *testing.T, got Project, wantName string, wantPath string, wantAbsPath string) {
	t.Helper()
	if got.Name != wantName {
		t.Fatalf("project.Name = %q, want %q", got.Name, wantName)
	}
	if got.Path != wantPath {
		t.Fatalf("project.Path = %q, want %q", got.Path, wantPath)
	}
	if got.AbsolutePath() != wantAbsPath {
		t.Fatalf("project.AbsolutePath() = %q, want %q", got.AbsolutePath(), wantAbsPath)
	}
	if got.ID == "" {
		t.Fatal("project.ID should not be empty")
	}
}
