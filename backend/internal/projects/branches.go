package projects

import (
	"bytes"
	"errors"
	"os/exec"
	"sort"
	"strings"
)

// Branch is a single local git branch. IsCurrent marks the checked-out branch.
type Branch struct {
	Name      string `json:"name"`
	IsCurrent bool   `json:"isCurrent"`
}

// BranchAction is a mutation requested against a project's local branches. Only
// the fields relevant to Action are populated by the caller.
type BranchAction struct {
	Action string `json:"action"` // checkout | create | delete | merge
	Branch string `json:"branch"` // checkout / delete target
	Base   string `json:"base"`   // create: branch to fork from
	Name   string `json:"name"`   // create: new branch name
	Source string `json:"source"` // merge: branch merged from
	Target string `json:"target"` // merge: branch merged into
}

// GitError carries a git command's stderr so it can be surfaced verbatim to the
// user (e.g. "Your local changes would be overwritten by checkout").
type GitError struct {
	Message string
}

func (e *GitError) Error() string {
	return e.Message
}

var (
	ErrInvalidBranchName   = errors.New("invalid branch name")
	ErrUnknownBranchAction = errors.New("unknown branch action")
)

// ListBranches returns the project's local branches sorted by name, marking the
// one currently checked out.
func ListBranches(root, projectID string) ([]Branch, error) {
	project, err := FindByID(root, projectID)
	if err != nil {
		return nil, err
	}

	// %(HEAD) is "*" for the checked-out branch and " " otherwise; the NUL
	// separator keeps branch names with spaces intact.
	output, err := gitInProject(project, "for-each-ref", "--format=%(HEAD)%00%(refname:short)", "refs/heads")
	if err != nil {
		return nil, err
	}

	branches := make([]Branch, 0)
	for _, line := range strings.Split(output, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}

		fields := strings.SplitN(line, "\x00", 2)
		if len(fields) != 2 {
			continue
		}

		branches = append(branches, Branch{
			Name:      fields[1],
			IsCurrent: strings.TrimSpace(fields[0]) == "*",
		})
	}

	sort.Slice(branches, func(left, right int) bool {
		return branches[left].Name < branches[right].Name
	})

	return branches, nil
}

// PerformBranchAction applies a checkout, create, delete, or merge to the
// project's branches and returns the refreshed branch list. Git failures (such
// as uncommitted changes blocking a checkout, an unmerged branch blocking a
// delete, or a merge conflict) are returned as *GitError carrying git's own
// message. A failed merge is aborted so the working tree is left clean.
func PerformBranchAction(root, projectID string, action BranchAction) ([]Branch, error) {
	project, err := FindByID(root, projectID)
	if err != nil {
		return nil, err
	}

	switch action.Action {
	case "checkout":
		if err := validateBranchName(action.Branch); err != nil {
			return nil, err
		}
		if _, err := gitInProject(project, "switch", action.Branch); err != nil {
			return nil, err
		}

	case "create":
		if err := validateBranchName(action.Name); err != nil {
			return nil, err
		}
		if err := validateBranchName(action.Base); err != nil {
			return nil, err
		}
		// Create without switching so creating a branch never disturbs the
		// working tree; the user can check it out separately.
		if _, err := gitInProject(project, "branch", action.Name, action.Base); err != nil {
			return nil, err
		}

	case "delete":
		if err := validateBranchName(action.Branch); err != nil {
			return nil, err
		}
		// -d is the safe delete: git refuses to drop an unmerged branch (or the
		// current one) and we surface that message rather than forcing.
		if _, err := gitInProject(project, "branch", "-d", action.Branch); err != nil {
			return nil, err
		}

	case "merge":
		if err := validateBranchName(action.Source); err != nil {
			return nil, err
		}
		if err := validateBranchName(action.Target); err != nil {
			return nil, err
		}
		if _, err := gitInProject(project, "switch", action.Target); err != nil {
			return nil, err
		}
		if _, err := gitInProject(project, "merge", "--no-edit", action.Source); err != nil {
			// Leave the working tree clean on conflict/failure rather than
			// stranding the user mid-merge.
			_, _ = gitInProject(project, "merge", "--abort")
			return nil, err
		}

	default:
		return nil, ErrUnknownBranchAction
	}

	return ListBranches(root, projectID)
}

// validateBranchName guards against empty names and, critically, names starting
// with "-" that git would otherwise parse as a flag. Git itself validates the
// remaining ref-format rules and reports a clear error.
func validateBranchName(name string) error {
	if name == "" || strings.HasPrefix(name, "-") {
		return ErrInvalidBranchName
	}

	return nil
}

// gitInProject runs a git command inside the project, marking the directory safe
// per-invocation with -c (mirroring ListFiles, avoiding the global config
// lock). A non-zero exit is returned as *GitError carrying the trimmed stderr.
func gitInProject(project Project, args ...string) (string, error) {
	full := append([]string{
		"-c", "safe.directory=" + project.AbsolutePath(),
		"-C", project.AbsolutePath(),
	}, args...)

	command := exec.Command("git", full...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr

	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = strings.TrimSpace(stdout.String())
		}
		if message == "" {
			message = err.Error()
		}
		return stdout.String(), &GitError{Message: message}
	}

	return stdout.String(), nil
}
