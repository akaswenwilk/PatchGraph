package projects

import (
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
	if !errorsIs(err, ErrRootNotConfigured) {
		t.Fatalf("RootFromEnv() error = %v, want %v", err, ErrRootNotConfigured)
	}
}

func TestDiscoverFindsNestedProjects(t *testing.T) {
	root := t.TempDir()

	createGitDir(t, filepath.Join(root, "alpha"))
	createGitDir(t, filepath.Join(root, "group", "beta"))
	createGitFile(t, filepath.Join(root, "workspace"))
	createGitDir(t, filepath.Join(root, "workspace", "nested-ignored"))
	mustMkdirAll(t, filepath.Join(root, "notes"))

	projects, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}

	want := []string{"alpha", "beta", "workspace"}
	assertProjects(t, projects, want)
}

func TestDiscoverDeduplicatesNamesAcrossRoots(t *testing.T) {
	root := t.TempDir()

	createGitDir(t, filepath.Join(root, "team-a", "PatchGraph"))
	createGitDir(t, filepath.Join(root, "team-b", "PatchGraph"))
	createGitDir(t, filepath.Join(root, "team-c", "AnotherRepo"))

	projects, err := Discover(root)
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}

	want := []string{"AnotherRepo", "PatchGraph"}
	assertProjects(t, projects, want)
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

func assertProjects(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("len(projects) = %d, want %d; got %v", len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("projects[%d] = %q, want %q; got %v", index, got[index], want[index], got)
		}
	}
}

func errorsIs(err, target error) bool {
	return err != nil && target != nil && err.Error() == target.Error()
}
