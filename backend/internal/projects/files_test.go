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
	runGit(t, repoPath, "commit", "-qm", "base")
	runGit(t, repoPath, "branch", "feature/review")

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
	if detail.CurrentBranch != "master" && detail.CurrentBranch != "main" {
		t.Fatalf("detail.CurrentBranch = %q, want master or main", detail.CurrentBranch)
	}
	if !slices.Contains(detail.Branches, "feature/review") {
		t.Fatalf("detail.Branches = %v, want feature/review", detail.Branches)
	}

	want := []string{".gitignore", "notes/draft.md", "src/visible.ts", "tracked.txt"}
	if !slices.Equal(detail.Files, want) {
		t.Fatalf("detail.Files = %v, want %v", detail.Files, want)
	}
}

func TestCheckoutBranchSwitchesCleanRepoAndRefreshesFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required for this test")
	}

	repoPath := filepath.Join(t.TempDir(), "PatchGraph")
	runGit(t, repoPath, "init", "-q")
	writeFile(t, filepath.Join(repoPath, "keep.txt"), "main\n")
	writeFile(t, filepath.Join(repoPath, "delete-me.txt"), "gone later\n")
	runGit(t, repoPath, "add", "keep.txt", "delete-me.txt")
	runGit(t, repoPath, "commit", "-qm", "base")
	runGit(t, repoPath, "checkout", "-qb", "feature/review")
	writeFile(t, filepath.Join(repoPath, "keep.txt"), "feature\n")
	if err := os.Remove(filepath.Join(repoPath, "delete-me.txt")); err != nil {
		t.Fatalf("Remove(delete-me.txt) error = %v", err)
	}
	writeFile(t, filepath.Join(repoPath, "new.txt"), "new\n")
	runGit(t, repoPath, "add", "-A")
	runGit(t, repoPath, "commit", "-qm", "feature")
	runGit(t, repoPath, "checkout", "-q", "-")

	root := filepath.Dir(repoPath)
	detail, err := CheckoutBranch(root, projectID(repoPath), "feature/review")
	if err != nil {
		t.Fatalf("CheckoutBranch() error = %v", err)
	}

	if detail.CurrentBranch != "feature/review" {
		t.Fatalf("detail.CurrentBranch = %q, want feature/review", detail.CurrentBranch)
	}
	if slices.Contains(detail.Files, "delete-me.txt") {
		t.Fatalf("detail.Files = %v, did not expect delete-me.txt", detail.Files)
	}
	if !slices.Contains(detail.Files, "new.txt") {
		t.Fatalf("detail.Files = %v, want new.txt", detail.Files)
	}
}

func TestCheckoutBranchRejectsDirtyWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required for this test")
	}

	repoPath := filepath.Join(t.TempDir(), "PatchGraph")
	runGit(t, repoPath, "init", "-q")
	writeFile(t, filepath.Join(repoPath, "tracked.txt"), "base\n")
	runGit(t, repoPath, "add", "tracked.txt")
	runGit(t, repoPath, "commit", "-qm", "base")
	runGit(t, repoPath, "branch", "feature/review")
	writeFile(t, filepath.Join(repoPath, "tracked.txt"), "dirty\n")

	root := filepath.Dir(repoPath)
	_, err := CheckoutBranch(root, projectID(repoPath), "feature/review")
	if !errors.Is(err, ErrDirtyWorktree) {
		t.Fatalf("CheckoutBranch() error = %v, want %v", err, ErrDirtyWorktree)
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
	if args[0] == "init" {
		runGit(t, repoPath, "config", "user.name", "PatchGraph Test")
		runGit(t, repoPath, "config", "user.email", "patchgraph@example.com")
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
