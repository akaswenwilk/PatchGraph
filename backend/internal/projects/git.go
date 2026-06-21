package projects

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strings"
)

var (
	// ErrUncommittedChanges reports that a branch switch was blocked because the
	// working tree has staged or unstaged modifications to tracked files.
	ErrUncommittedChanges = errors.New("uncommitted changes")
	// ErrBranchNotFound reports that the requested branch is not a local branch.
	ErrBranchNotFound = errors.New("branch not found")
)

// GitInfo describes the branch state of a project's git repository.
type GitInfo struct {
	// Current is the name of the currently checked-out branch. It is empty when
	// the repository is in a detached HEAD state.
	Current string `json:"current"`
	// Branches lists every local branch, sorted alphabetically. It includes the
	// current branch.
	Branches []string `json:"branches"`
}

// GetGitInfo resolves a project by id and reports its local branch state.
func GetGitInfo(root, id string) (GitInfo, error) {
	project, err := FindByID(root, id)
	if err != nil {
		return GitInfo{}, err
	}

	return gitInfo(project)
}

// CheckoutBranch switches the project's repository to the named local branch
// and returns the resulting branch state. It refuses to switch when the working
// tree has uncommitted changes to tracked files (ErrUncommittedChanges) or when
// the branch is not a known local branch (ErrBranchNotFound), so the caller can
// surface an actionable message rather than risk clobbering work.
func CheckoutBranch(root, id, branch string) (GitInfo, error) {
	project, err := FindByID(root, id)
	if err != nil {
		return GitInfo{}, err
	}

	branches, err := localBranches(project)
	if err != nil {
		return GitInfo{}, err
	}
	if !slices.Contains(branches, branch) {
		return GitInfo{}, ErrBranchNotFound
	}

	dirty, err := hasUncommittedChanges(project)
	if err != nil {
		return GitInfo{}, err
	}
	if dirty {
		return GitInfo{}, ErrUncommittedChanges
	}

	output, err := gitCommand(project, "checkout", branch).CombinedOutput()
	if err != nil {
		return GitInfo{}, fmt.Errorf("git checkout %s: %w: %s", branch, err, strings.TrimSpace(string(output)))
	}

	return gitInfo(project)
}

// gitInfo reports the current and local branch state for an already-resolved
// project.
func gitInfo(project Project) (GitInfo, error) {
	current, err := currentBranch(project)
	if err != nil {
		return GitInfo{}, err
	}

	branches, err := localBranches(project)
	if err != nil {
		return GitInfo{}, err
	}

	return GitInfo{Current: current, Branches: branches}, nil
}

// hasUncommittedChanges reports whether the working tree has staged or unstaged
// changes to tracked files. Untracked files are ignored: git carries them
// across a branch switch without data loss, so they should not block one.
func hasUncommittedChanges(project Project) (bool, error) {
	output, err := gitCommand(project, "status", "--porcelain").Output()
	if err != nil {
		return false, err
	}

	for _, line := range bytes.Split(output, []byte{'\n'}) {
		trimmed := bytes.TrimRight(line, "\r")
		if len(bytes.TrimSpace(trimmed)) == 0 {
			continue
		}
		// "??" marks an untracked file; everything else is a tracked change.
		if bytes.HasPrefix(trimmed, []byte("??")) {
			continue
		}
		return true, nil
	}

	return false, nil
}

// currentBranch returns the checked-out branch name, or "" when HEAD is
// detached.
func currentBranch(project Project) (string, error) {
	output, err := gitCommand(project, "symbolic-ref", "--quiet", "--short", "HEAD").Output()
	if err != nil {
		// A non-zero exit from symbolic-ref means HEAD is detached rather than a
		// hard failure, so report an empty current branch.
		if _, ok := err.(*exec.ExitError); ok {
			return "", nil
		}
		return "", err
	}

	return strings.TrimSpace(string(output)), nil
}

// localBranches lists every local branch, sorted alphabetically.
func localBranches(project Project) ([]string, error) {
	output, err := gitCommand(
		project,
		"for-each-ref",
		"--sort=refname",
		"--format=%(refname:short)",
		"refs/heads",
	).Output()
	if err != nil {
		return nil, err
	}

	branches := make([]string, 0)
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		name := strings.TrimSpace(string(line))
		if name == "" {
			continue
		}
		branches = append(branches, name)
	}

	return branches, nil
}

// gitCommand builds a git invocation scoped to the project directory. It marks
// the directory safe per-invocation with -c rather than mutating the global git
// config, matching ListFiles and avoiding the global config lock race.
func gitCommand(project Project, args ...string) *exec.Cmd {
	fullArgs := append([]string{
		"-c",
		"safe.directory=" + project.AbsolutePath(),
		"-C",
		project.AbsolutePath(),
	}, args...)

	return exec.Command("git", fullArgs...)
}
