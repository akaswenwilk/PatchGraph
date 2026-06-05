package projects

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func TestListFilesUsesGitIgnore(t *testing.T) {
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

	files, err := ListFiles(Project{Name: "PatchGraph", Path: "PatchGraph", absPath: repoPath})
	if err != nil {
		t.Fatalf("ListFiles() error = %v", err)
	}

	want := []string{".gitignore", "notes/draft.md", "src/visible.ts", "tracked.txt"}
	if !slices.Equal(files, want) {
		t.Fatalf("ListFiles() = %v, want %v", files, want)
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
