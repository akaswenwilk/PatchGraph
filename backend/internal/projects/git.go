package projects

import (
	"bytes"
	"os/exec"
	"strings"
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
