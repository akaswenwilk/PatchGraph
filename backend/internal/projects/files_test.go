package projects

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestGetReturnsProjectDetailWithGitAwareFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required for this test")
	}

	repoPath := filepath.Join(t.TempDir(), "PatchGraph")
	runGit(t, repoPath, "init", "-q")
	writeFile(t, filepath.Join(repoPath, ".gitignore"), "ignored/\n*.log\n")
	writeFile(t, filepath.Join(repoPath, "tracked.txt"), "tracked\n")
	writeFile(t, filepath.Join(repoPath, "src", "visible.ts"), "export {}\n")
	writeFile(t, filepath.Join(repoPath, "notes", "draft.md"), "draft\n")
	writeFile(t, filepath.Join(repoPath, "ignored", "secret.txt"), "hidden\n")
	writeFile(t, filepath.Join(repoPath, "debug.log"), "hidden\n")
	runGit(t, repoPath, "add", ".gitignore", "tracked.txt", "src/visible.ts")

	root := filepath.Dir(repoPath)
	project, err := FindByID(root, projectID(repoPath))
	if err != nil {
		t.Fatalf("FindByID() error = %v", err)
	}

	detail, err := Get(root, project.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}

	if detail.ID != project.ID || detail.Name != "PatchGraph" || detail.Path != "PatchGraph" {
		t.Fatalf("detail = %+v", detail)
	}

	want := []string{".gitignore", "notes/draft.md", "src/visible.ts", "tracked.txt"}
	if !slices.Equal(detail.Files, want) {
		t.Fatalf("detail.Files = %v, want %v", detail.Files, want)
	}
}

func TestReadFileLinesReturnsEachLineWithoutTrailingNewline(t *testing.T) {
	repoPath := filepath.Join(t.TempDir(), "PatchGraph")
	createRepoGitDir(t, repoPath)
	mustWriteFile(t, filepath.Join(repoPath, "notes.txt"), "first\n\tsecond\nthird")

	root := filepath.Dir(repoPath)
	lines, err := ReadFileLines(root, projectID(repoPath), "notes.txt")
	if err != nil {
		t.Fatalf("ReadFileLines() error = %v", err)
	}

	want := []string{"first", "\tsecond", "third"}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %v, want %v", lines, want)
	}
}

func TestReadFileLinesRejectsEscapingPaths(t *testing.T) {
	repoPath := filepath.Join(t.TempDir(), "PatchGraph")
	createRepoGitDir(t, repoPath)

	root := filepath.Dir(repoPath)
	_, err := ReadFileLines(root, projectID(repoPath), "../secret.txt")
	if !errors.Is(err, ErrInvalidFilePath) {
		t.Fatalf("ReadFileLines() error = %v, want %v", err, ErrInvalidFilePath)
	}
}

func TestReadLinesHandlesEmptyFinalLine(t *testing.T) {
	lines, err := readLines(strings.NewReader("alpha\n\n"))
	if err != nil {
		t.Fatalf("readLines() error = %v", err)
	}

	want := []string{"alpha", ""}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %v, want %v", lines, want)
	}
}

func runGit(t *testing.T, repoPath string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", repoPath}, args...)...)
	if args[0] == "init" {
		if err := os.MkdirAll(repoPath, 0o755); err != nil {
			t.Fatalf("MkdirAll(%q) error = %v", repoPath, err)
		}
	}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
}

func writeFile(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", path, err)
	}
}

func mustWriteFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", path, err)
	}
}

func createRepoGitDir(t *testing.T, repoPath string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(repoPath, ".git"), 0o755); err != nil {
		t.Fatalf("MkdirAll(.git) error = %v", err)
	}
}
