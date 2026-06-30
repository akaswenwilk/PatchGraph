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

func TestCompareBranchesReturnsLineDiffs(t *testing.T) {
	root, id := setupBranchRepo(t)
	repoPath := filepath.Join(root, "PatchGraph")
	runGit(t, repoPath, "switch", "-c", "feature")
	writeFile(t, filepath.Join(repoPath, "base.txt"), "base\nfeature\n")
	writeFile(t, filepath.Join(repoPath, "added.txt"), "new\n")
	runGit(t, repoPath, "add", "base.txt", "added.txt")
	runGit(t, repoPath, "commit", "-qm", "feature work")

	comparison, err := CompareBranches(root, id, "main", "feature")
	if err != nil {
		t.Fatalf("CompareBranches() error = %v", err)
	}
	if comparison.Base != "main" || comparison.Compare != "feature" {
		t.Fatalf("comparison = %#v, want main..feature", comparison)
	}
	if len(comparison.Files) != 2 {
		t.Fatalf("len(files) = %d, want 2: %#v", len(comparison.Files), comparison.Files)
	}

	var baseDiff *FileDiff
	for index := range comparison.Files {
		if comparison.Files[index].Filename == "base.txt" {
			baseDiff = &comparison.Files[index]
		}
	}
	if baseDiff == nil {
		t.Fatalf("base.txt diff missing: %#v", comparison.Files)
	}
	if len(baseDiff.Lines) != 2 {
		t.Fatalf("len(base lines) = %d, want 2: %#v", len(baseDiff.Lines), baseDiff.Lines)
	}
	if baseDiff.Lines[0].Kind != "context" || baseDiff.Lines[0].OldLine != 1 || baseDiff.Lines[0].NewLine != 1 {
		t.Fatalf("first line = %#v, want context line 1/1", baseDiff.Lines[0])
	}
	if baseDiff.Lines[1].Kind != "added" || baseDiff.Lines[1].NewLine != 2 || baseDiff.Lines[1].Text != "feature" {
		t.Fatalf("second line = %#v, want added feature at new line 2", baseDiff.Lines[1])
	}
}

func TestCompareBranchesCollapsesHunksAndMarksChangedText(t *testing.T) {
	root, id := setupBranchRepo(t)
	repoPath := filepath.Join(root, "PatchGraph")
	contents := "one\ntwo()\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\nfourteen\nfifteen\nsixteen\nseventeen\neighteen()\nnineteen\ntwenty\n"
	writeFile(t, filepath.Join(repoPath, "main.go"), contents)
	runGit(t, repoPath, "add", "main.go")
	runGit(t, repoPath, "commit", "-qm", "add main")

	runGit(t, repoPath, "switch", "-c", "feature")
	changed := "one\ntwo(extra)\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\nfourteen\nfifteen\nsixteen\nseventeen\neighteen(extra)\nnineteen\ntwenty\n"
	writeFile(t, filepath.Join(repoPath, "main.go"), changed)
	runGit(t, repoPath, "commit", "-aqm", "edit separated hunks")

	comparison, err := CompareBranches(root, id, "main", "feature")
	if err != nil {
		t.Fatalf("CompareBranches() error = %v", err)
	}

	mainDiffs := make([]FileDiff, 0)
	for _, file := range comparison.Files {
		if file.Filename == "main.go" {
			mainDiffs = append(mainDiffs, file)
		}
	}
	if len(mainDiffs) != 1 {
		t.Fatalf("main.go diffs = %d, want 1: %#v", len(mainDiffs), mainDiffs)
	}
	if mainDiffs[0].Header != "2 hunks" {
		t.Fatalf("main.go header = %q, want 2 hunks", mainDiffs[0].Header)
	}

	var collapsedLine *DiffLine
	for index := range mainDiffs[0].Lines {
		if mainDiffs[0].Lines[index].Kind == "collapsed" {
			collapsedLine = &mainDiffs[0].Lines[index]
			break
		}
	}
	if collapsedLine == nil {
		t.Fatalf("main.go diff has no collapsed line: %#v", mainDiffs[0].Lines)
	}
	if len(collapsedLine.Hidden) == 0 {
		t.Fatalf("collapsed line hidden lines = %#v, want hidden context", collapsedLine.Hidden)
	}

	var addedLine *DiffLine
	for index := range mainDiffs[0].Lines {
		if mainDiffs[0].Lines[index].Kind == "added" {
			addedLine = &mainDiffs[0].Lines[index]
			break
		}
	}
	if addedLine == nil {
		t.Fatalf("main.go diff has no added line: %#v", mainDiffs[0].Lines)
	}
	if len(addedLine.Changes) != 1 {
		t.Fatalf("added line changes = %#v, want one changed range", addedLine.Changes)
	}
	changedText := addedLine.Text[addedLine.Changes[0].Start:addedLine.Changes[0].End]
	if changedText != "extra" {
		t.Fatalf("changed text = %q, want extra", changedText)
	}
}

func TestCompareBranchesCollapsesUnchangedBoundaries(t *testing.T) {
	root, id := setupBranchRepo(t)
	repoPath := filepath.Join(root, "PatchGraph")
	contents := "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\nthirteen\nfourteen\n"
	writeFile(t, filepath.Join(repoPath, "main.go"), contents)
	runGit(t, repoPath, "add", "main.go")
	runGit(t, repoPath, "commit", "-qm", "add main")

	runGit(t, repoPath, "switch", "-c", "feature")
	changed := "one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nten\neleven\ntwelve\nthirteen\nfourteen\n"
	writeFile(t, filepath.Join(repoPath, "main.go"), changed)
	runGit(t, repoPath, "commit", "-aqm", "edit middle line")

	comparison, err := CompareBranches(root, id, "main", "feature")
	if err != nil {
		t.Fatalf("CompareBranches() error = %v", err)
	}

	var mainDiff *FileDiff
	for index := range comparison.Files {
		if comparison.Files[index].Filename == "main.go" {
			mainDiff = &comparison.Files[index]
			break
		}
	}
	if mainDiff == nil {
		t.Fatalf("main.go diff not found: %#v", comparison.Files)
	}
	if len(mainDiff.Lines) < 3 {
		t.Fatalf("main.go lines = %#v, want boundary collapsed rows around hunk", mainDiff.Lines)
	}

	leading := mainDiff.Lines[0]
	if leading.Kind != "collapsed" || len(leading.Hidden) != 4 || leading.Hidden[0].NewLine != 1 || leading.Hidden[3].NewLine != 4 {
		t.Fatalf("leading collapsed line = %#v, want hidden new lines 1-4", leading)
	}
	trailing := mainDiff.Lines[len(mainDiff.Lines)-1]
	if trailing.Kind != "collapsed" || len(trailing.Hidden) != 3 || trailing.Hidden[0].NewLine != 12 || trailing.Hidden[2].NewLine != 14 {
		t.Fatalf("trailing collapsed line = %#v, want hidden new lines 12-14", trailing)
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
