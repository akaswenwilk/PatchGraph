package projects

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDiscoverNamesReturnsRecursiveGitProjects(t *testing.T) {
	root := t.TempDir()
	createProject(t, root, "alpha")
	createProject(t, root, filepath.Join("nested", "beta"))
	createDirectory(t, root, filepath.Join("nested", "not-a-project"))
	createFile(t, root, filepath.Join("gamma", "go.mod"))

	projectNames, err := DiscoverNames(root)
	if err != nil {
		t.Fatalf("discover names: %v", err)
	}

	want := []string{"alpha", "beta"}
	if !reflect.DeepEqual(projectNames, want) {
		t.Fatalf("unexpected project names: got %#v want %#v", projectNames, want)
	}
}

func TestDiscoverNamesFromEnvReturnsEmptyWhenUnset(t *testing.T) {
	t.Setenv(projectsRootEnv, "")

	projectNames, err := DiscoverNamesFromEnv()
	if err != nil {
		t.Fatalf("discover names from env: %v", err)
	}

	if len(projectNames) != 0 {
		t.Fatalf("expected empty project list, got %#v", projectNames)
	}
}

func TestDiscoverNamesRejectsFileRoot(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "projects.txt")
	createFile(t, root, "projects.txt")

	_, err := DiscoverNames(filePath)
	if err == nil {
		t.Fatal("expected error for file root")
	}
}

func TestDiscoverNamesDeduplicatesProjectNames(t *testing.T) {
	root := t.TempDir()
	createProject(t, root, filepath.Join("first", "shared"))
	createProject(t, root, filepath.Join("second", "shared"))

	projectNames, err := DiscoverNames(root)
	if err != nil {
		t.Fatalf("discover names: %v", err)
	}

	want := []string{"shared"}
	if !reflect.DeepEqual(projectNames, want) {
		t.Fatalf("unexpected project names: got %#v want %#v", projectNames, want)
	}
}

func createProject(t *testing.T, root string, relativePath string) {
	t.Helper()
	createDirectory(t, root, filepath.Join(relativePath, ".git"))
}

func createDirectory(t *testing.T, root string, relativePath string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, relativePath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", relativePath, err)
	}
}

func createFile(t *testing.T, root string, relativePath string) {
	t.Helper()
	fullPath := filepath.Join(root, relativePath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir parents for %s: %v", relativePath, err)
	}

	if err := os.WriteFile(fullPath, []byte("test"), 0o644); err != nil {
		t.Fatalf("write %s: %v", relativePath, err)
	}
}
