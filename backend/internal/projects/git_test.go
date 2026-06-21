package projects

import (
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func TestGetGitInfoReportsCurrentAndLocalBranches(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required for this test")
	}

	repoPath := filepath.Join(t.TempDir(), "PatchGraph")
	runGit(t, repoPath, "init", "-q")
	runGit(t, repoPath, "config", "user.email", "test@example.com")
	runGit(t, repoPath, "config", "user.name", "Test")
	writeFile(t, filepath.Join(repoPath, "tracked.txt"), "tracked\n")
	runGit(t, repoPath, "add", "tracked.txt")
	runGit(t, repoPath, "commit", "-q", "-m", "initial")
	runGit(t, repoPath, "branch", "-m", "main")
	runGit(t, repoPath, "branch", "feature/foo")

	root := filepath.Dir(repoPath)
	info, err := GetGitInfo(root, projectID(repoPath))
	if err != nil {
		t.Fatalf("GetGitInfo() error = %v", err)
	}

	if info.Current != "main" {
		t.Fatalf("info.Current = %q, want %q", info.Current, "main")
	}
	want := []string{"feature/foo", "main"}
	if !slices.Equal(info.Branches, want) {
		t.Fatalf("info.Branches = %v, want %v", info.Branches, want)
	}
}

func TestGetGitInfoReportsEmptyCurrentWhenDetached(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required for this test")
	}

	repoPath := filepath.Join(t.TempDir(), "PatchGraph")
	runGit(t, repoPath, "init", "-q")
	runGit(t, repoPath, "config", "user.email", "test@example.com")
	runGit(t, repoPath, "config", "user.name", "Test")
	writeFile(t, filepath.Join(repoPath, "tracked.txt"), "tracked\n")
	runGit(t, repoPath, "add", "tracked.txt")
	runGit(t, repoPath, "commit", "-q", "-m", "initial")
	runGit(t, repoPath, "checkout", "-q", "--detach", "HEAD")

	root := filepath.Dir(repoPath)
	info, err := GetGitInfo(root, projectID(repoPath))
	if err != nil {
		t.Fatalf("GetGitInfo() error = %v", err)
	}

	if info.Current != "" {
		t.Fatalf("info.Current = %q, want empty", info.Current)
	}
}
