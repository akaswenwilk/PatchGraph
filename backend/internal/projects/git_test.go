package projects

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

// initBranchedRepo creates a committed repo on `main` with an extra
// `feature/foo` branch and returns the repo path and its projects root.
func initBranchedRepo(t *testing.T) (string, string) {
	t.Helper()
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
	runGit(t, repoPath, "branch", "-M", "main")
	runGit(t, repoPath, "branch", "feature/foo")

	return repoPath, filepath.Dir(repoPath)
}

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

func TestCheckoutBranchSwitchesBranch(t *testing.T) {
	repoPath, root := initBranchedRepo(t)

	info, err := CheckoutBranch(root, projectID(repoPath), "feature/foo")
	if err != nil {
		t.Fatalf("CheckoutBranch() error = %v", err)
	}
	if info.Current != "feature/foo" {
		t.Fatalf("info.Current = %q, want %q", info.Current, "feature/foo")
	}

	// The switch is reflected on disk, not just in the returned struct.
	again, err := GetGitInfo(root, projectID(repoPath))
	if err != nil {
		t.Fatalf("GetGitInfo() error = %v", err)
	}
	if again.Current != "feature/foo" {
		t.Fatalf("re-read current = %q, want %q", again.Current, "feature/foo")
	}
}

func TestCheckoutBranchRejectsUnknownBranch(t *testing.T) {
	repoPath, root := initBranchedRepo(t)

	_, err := CheckoutBranch(root, projectID(repoPath), "does-not-exist")
	if !errors.Is(err, ErrBranchNotFound) {
		t.Fatalf("CheckoutBranch() error = %v, want %v", err, ErrBranchNotFound)
	}
}

func TestCheckoutBranchRejectsUncommittedChanges(t *testing.T) {
	repoPath, root := initBranchedRepo(t)

	// Modify a tracked file so the working tree is dirty.
	if err := os.WriteFile(filepath.Join(repoPath, "tracked.txt"), []byte("changed\n"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	_, err := CheckoutBranch(root, projectID(repoPath), "feature/foo")
	if !errors.Is(err, ErrUncommittedChanges) {
		t.Fatalf("CheckoutBranch() error = %v, want %v", err, ErrUncommittedChanges)
	}
}

func TestCheckoutBranchIgnoresUntrackedFiles(t *testing.T) {
	repoPath, root := initBranchedRepo(t)

	// An untracked file is carried across the switch by git, so it must not
	// block the checkout.
	if err := os.WriteFile(filepath.Join(repoPath, "scratch.txt"), []byte("scratch\n"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	info, err := CheckoutBranch(root, projectID(repoPath), "feature/foo")
	if err != nil {
		t.Fatalf("CheckoutBranch() error = %v", err)
	}
	if info.Current != "feature/foo" {
		t.Fatalf("info.Current = %q, want %q", info.Current, "feature/foo")
	}
}
