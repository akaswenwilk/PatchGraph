package projects

import (
	"bytes"
	"errors"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
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

// BranchComparison is the file-level diff between two local branches. Lines use
// one-based old/new line numbers; removed lines have no NewLine, added lines have
// no OldLine.
type BranchComparison struct {
	Base    string     `json:"base"`
	Compare string     `json:"compare"`
	Files   []FileDiff `json:"files"`
}

type FileDiff struct {
	Filename string     `json:"filename"`
	OldPath  string     `json:"oldPath,omitempty"`
	Status   string     `json:"status"`
	Lines    []DiffLine `json:"lines"`
}

type DiffLine struct {
	Kind    string `json:"kind"` // context | added | removed
	OldLine int    `json:"oldLine,omitempty"`
	NewLine int    `json:"newLine,omitempty"`
	Text    string `json:"text"`
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

var diffHunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

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

// CompareBranches returns a parsed unified diff for base..compare without
// changing the working tree.
func CompareBranches(root, projectID, base, compare string) (BranchComparison, error) {
	project, err := FindByID(root, projectID)
	if err != nil {
		return BranchComparison{}, err
	}
	if err := validateBranchName(base); err != nil {
		return BranchComparison{}, err
	}
	if err := validateBranchName(compare); err != nil {
		return BranchComparison{}, err
	}

	output, err := gitInProject(
		project,
		"diff",
		"--no-ext-diff",
		"--no-color",
		"--find-renames",
		"--unified=100000",
		base+".."+compare,
		"--",
	)
	if err != nil {
		return BranchComparison{}, err
	}

	return BranchComparison{
		Base:    base,
		Compare: compare,
		Files:   parseUnifiedDiff(output),
	}, nil
}

func parseUnifiedDiff(output string) []FileDiff {
	files := make([]FileDiff, 0)
	var current *FileDiff
	oldLine := 0
	newLine := 0

	flush := func() {
		if current != nil {
			files = append(files, *current)
			current = nil
		}
	}

	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			flush()
			current = &FileDiff{Status: "modified"}
			oldLine = 0
			newLine = 0
			continue
		}
		if current == nil {
			continue
		}

		switch {
		case strings.HasPrefix(line, "rename from "):
			current.OldPath = strings.TrimPrefix(line, "rename from ")
		case strings.HasPrefix(line, "rename to "):
			current.Filename = strings.TrimPrefix(line, "rename to ")
			current.Status = "renamed"
		case strings.HasPrefix(line, "new file mode "):
			current.Status = "added"
		case strings.HasPrefix(line, "deleted file mode "):
			current.Status = "deleted"
		case strings.HasPrefix(line, "--- "):
			path := diffPath(strings.TrimPrefix(line, "--- "))
			if path != "" && current.OldPath == "" {
				current.OldPath = path
			}
		case strings.HasPrefix(line, "+++ "):
			path := diffPath(strings.TrimPrefix(line, "+++ "))
			if path != "" {
				current.Filename = path
			} else if current.Filename == "" {
				current.Filename = current.OldPath
			}
		case strings.HasPrefix(line, "@@ "):
			matches := diffHunkHeader.FindStringSubmatch(line)
			if len(matches) == 3 {
				oldLine, _ = strconv.Atoi(matches[1])
				newLine, _ = strconv.Atoi(matches[2])
			}
		case strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++"):
			current.Lines = append(current.Lines, DiffLine{Kind: "added", NewLine: newLine, Text: line[1:]})
			newLine++
		case strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---"):
			current.Lines = append(current.Lines, DiffLine{Kind: "removed", OldLine: oldLine, Text: line[1:]})
			oldLine++
		case strings.HasPrefix(line, " "):
			current.Lines = append(current.Lines, DiffLine{Kind: "context", OldLine: oldLine, NewLine: newLine, Text: line[1:]})
			oldLine++
			newLine++
		}
	}
	flush()

	return files
}

func diffPath(path string) string {
	if path == "/dev/null" {
		return ""
	}
	path = strings.TrimPrefix(path, "a/")
	path = strings.TrimPrefix(path, "b/")
	return path
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
