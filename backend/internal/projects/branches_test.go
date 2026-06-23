package projects

import (
	"errors"
	"os/exec"
	"path/filepath"
	"testing"
)

// setupBranchRepo creates a repo with an initial commit on a "main" branch and
// returns the projects root plus the project ID. Git identity is set locally so
// commits work regardless of the host's global config.
func setupBranchRepo(t *testing.T) (string, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required for this test")
	}

	repoPath := filepath.Join(t.TempDir(), "PatchGraph")
	runGit(t, repoPath, "init", "-q", "-b", "main")
	runGit(t, repoPath, "config", "user.email", "test@example.com")
	runGit(t, repoPath, "config", "user.name", "Test")
	writeFile(t, filepath.Join(repoPath, "base.txt"), "base\n")
	runGit(t, repoPath, "add", "base.txt")
	runGit(t, repoPath, "commit", "-q", "-m", "initial")

	return filepath.Dir(repoPath), projectID(repoPath)
}

func branchNames(branches []Branch) []string {
	names := make([]string, len(branches))
	for index, branch := range branches {
		names[index] = branch.Name
	}
	return names
}

func currentBranch(branches []Branch) string {
	for _, branch := range branches {
		if branch.IsCurrent {
			return branch.Name
		}
	}
	return ""
}

func TestListBranchesMarksCurrent(t *testing.T) {
	root, id := setupBranchRepo(t)
	runGit(t, filepath.Join(root, "PatchGraph"), "branch", "feature/login")

	branches, err := ListBranches(root, id)
	if err != nil {
		t.Fatalf("ListBranches() error = %v", err)
	}

	if got := branchNames(branches); len(got) != 2 || got[0] != "feature/login" || got[1] != "main" {
		t.Fatalf("branch names = %v, want [feature/login main]", got)
	}
	if current := currentBranch(branches); current != "main" {
		t.Fatalf("current branch = %q, want main", current)
	}
}

func TestPerformBranchActionCheckoutSwitches(t *testing.T) {
	root, id := setupBranchRepo(t)
	runGit(t, filepath.Join(root, "PatchGraph"), "branch", "develop")

	branches, err := PerformBranchAction(root, id, BranchAction{Action: "checkout", Branch: "develop"})
	if err != nil {
		t.Fatalf("checkout error = %v", err)
	}
	if current := currentBranch(branches); current != "develop" {
		t.Fatalf("current branch = %q, want develop", current)
	}
}

func TestPerformBranchActionCheckoutReportsUncommittedChanges(t *testing.T) {
	root, id := setupBranchRepo(t)
	repoPath := filepath.Join(root, "PatchGraph")
	runGit(t, repoPath, "branch", "develop")
	// Create a conflicting committed change on develop, then leave an
	// uncommitted edit on main so the switch is blocked.
	runGit(t, repoPath, "switch", "develop")
	writeFile(t, filepath.Join(repoPath, "base.txt"), "develop change\n")
	runGit(t, repoPath, "commit", "-aqm", "develop change")
	runGit(t, repoPath, "switch", "main")
	writeFile(t, filepath.Join(repoPath, "base.txt"), "uncommitted\n")

	_, err := PerformBranchAction(root, id, BranchAction{Action: "checkout", Branch: "develop"})
	var gitErr *GitError
	if !errors.As(err, &gitErr) {
		t.Fatalf("error = %v, want *GitError", err)
	}
	if gitErr.Message == "" {
		t.Fatal("GitError message is empty, want git's checkout failure text")
	}
}

func TestPerformBranchActionCreateForksWithoutSwitching(t *testing.T) {
	root, id := setupBranchRepo(t)

	branches, err := PerformBranchAction(root, id, BranchAction{Action: "create", Name: "feature/new", Base: "main"})
	if err != nil {
		t.Fatalf("create error = %v", err)
	}
	if names := branchNames(branches); len(names) != 2 || names[0] != "feature/new" {
		t.Fatalf("branch names = %v, want feature/new present", names)
	}
	// Creating must not switch away from main.
	if current := currentBranch(branches); current != "main" {
		t.Fatalf("current branch = %q, want main", current)
	}
}

func TestPerformBranchActionDeleteRemovesBranch(t *testing.T) {
	root, id := setupBranchRepo(t)
	runGit(t, filepath.Join(root, "PatchGraph"), "branch", "stale")

	branches, err := PerformBranchAction(root, id, BranchAction{Action: "delete", Branch: "stale"})
	if err != nil {
		t.Fatalf("delete error = %v", err)
	}
	for _, name := range branchNames(branches) {
		if name == "stale" {
			t.Fatalf("branch stale was not deleted: %v", branchNames(branches))
		}
	}
}

func TestPerformBranchActionDeleteCurrentBranchErrors(t *testing.T) {
	root, id := setupBranchRepo(t)

	_, err := PerformBranchAction(root, id, BranchAction{Action: "delete", Branch: "main"})
	var gitErr *GitError
	if !errors.As(err, &gitErr) {
		t.Fatalf("error = %v, want *GitError for deleting current branch", err)
	}
}

func TestPerformBranchActionMergeFastForwards(t *testing.T) {
	root, id := setupBranchRepo(t)
	repoPath := filepath.Join(root, "PatchGraph")
	runGit(t, repoPath, "switch", "-c", "feature")
	writeFile(t, filepath.Join(repoPath, "feature.txt"), "feature\n")
	runGit(t, repoPath, "add", "feature.txt")
	runGit(t, repoPath, "commit", "-qm", "feature work")
	runGit(t, repoPath, "switch", "main")

	branches, err := PerformBranchAction(root, id, BranchAction{Action: "merge", Source: "feature", Target: "main"})
	if err != nil {
		t.Fatalf("merge error = %v", err)
	}
	// Merge checks out the target.
	if current := currentBranch(branches); current != "main" {
		t.Fatalf("current branch = %q, want main", current)
	}
	if _, _, err := ResolveFile(root, id, "feature.txt"); err != nil {
		t.Fatalf("expected feature.txt merged into main: %v", err)
	}
}

func TestPerformBranchActionMergeConflictAborts(t *testing.T) {
	root, id := setupBranchRepo(t)
	repoPath := filepath.Join(root, "PatchGraph")
	// Diverge base.txt on both branches so the merge conflicts.
	runGit(t, repoPath, "switch", "-c", "feature")
	writeFile(t, filepath.Join(repoPath, "base.txt"), "feature side\n")
	runGit(t, repoPath, "commit", "-aqm", "feature edit")
	runGit(t, repoPath, "switch", "main")
	writeFile(t, filepath.Join(repoPath, "base.txt"), "main side\n")
	runGit(t, repoPath, "commit", "-aqm", "main edit")

	_, err := PerformBranchAction(root, id, BranchAction{Action: "merge", Source: "feature", Target: "main"})
	var gitErr *GitError
	if !errors.As(err, &gitErr) {
		t.Fatalf("error = %v, want *GitError for merge conflict", err)
	}

	// The failed merge must have been aborted, leaving no MERGE_HEAD behind.
	status := exec.Command("git", "-C", repoPath, "status", "--porcelain")
	output, statusErr := status.CombinedOutput()
	if statusErr != nil {
		t.Fatalf("git status error = %v", statusErr)
	}
	if len(output) != 0 {
		t.Fatalf("working tree not clean after aborted merge: %q", output)
	}
}

func TestPerformBranchActionRejectsUnknownAction(t *testing.T) {
	root, id := setupBranchRepo(t)

	_, err := PerformBranchAction(root, id, BranchAction{Action: "rebase", Branch: "main"})
	if !errors.Is(err, ErrUnknownBranchAction) {
		t.Fatalf("error = %v, want ErrUnknownBranchAction", err)
	}
}

func TestPerformBranchActionRejectsInvalidBranchName(t *testing.T) {
	root, id := setupBranchRepo(t)

	_, err := PerformBranchAction(root, id, BranchAction{Action: "checkout", Branch: "-rf"})
	if !errors.Is(err, ErrInvalidBranchName) {
		t.Fatalf("error = %v, want ErrInvalidBranchName", err)
	}
}
