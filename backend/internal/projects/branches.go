package projects

import (
	"bytes"
	"errors"
	"fmt"
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

// BranchComparison is the file-level diff between two local branches. Large
// unchanged spans between hunks are represented as collapsed DiffLine entries.
type BranchComparison struct {
	Base    string     `json:"base"`
	Compare string     `json:"compare"`
	Files   []FileDiff `json:"files"`
}

type FileDiff struct {
	Filename  string     `json:"filename"`
	OldPath   string     `json:"oldPath,omitempty"`
	Status    string     `json:"status"`
	HunkIndex int        `json:"hunkIndex"`
	Header    string     `json:"header"`
	Lines     []DiffLine `json:"lines"`
}

type DiffLine struct {
	Kind    string              `json:"kind"` // context | added | removed | collapsed
	OldLine int                 `json:"oldLine,omitempty"`
	NewLine int                 `json:"newLine,omitempty"`
	Text    string              `json:"text"`
	Changes []DiffLineHighlight `json:"changes,omitempty"`
	Hidden  []DiffLine          `json:"hidden,omitempty"`
}

type DiffLineHighlight struct {
	Start int `json:"start"`
	End   int `json:"end"`
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
		"--unified=3",
		base+".."+compare,
		"--",
	)
	if err != nil {
		return BranchComparison{}, err
	}

	return BranchComparison{
		Base:    base,
		Compare: compare,
		Files:   collapseDiffHunks(project, base, compare, parseUnifiedDiff(output)),
	}, nil
}

func collapseDiffHunks(project Project, base, compare string, hunks []FileDiff) []FileDiff {
	files := make([]FileDiff, 0)
	for index := 0; index < len(hunks); {
		first := hunks[index]
		key := first.filenameKey()
		end := index + 1
		for end < len(hunks) && hunks[end].filenameKey() == key {
			end++
		}

		fileHunks := hunks[index:end]
		collapsed := FileDiff{
			Filename: first.Filename,
			OldPath:  first.OldPath,
			Status:   first.Status,
			Header:   fmt.Sprintf("%d %s", len(fileHunks), pluralize("hunk", len(fileHunks))),
		}

		contentRef := compare
		contentPath := first.Filename
		useOldSide := first.Status == "deleted"
		if useOldSide {
			contentRef = base
			contentPath = first.OldPath
		}
		content := readGitFileLines(project, contentRef, contentPath)
		appendCollapsedLines := func(hidden []DiffLine) {
			if len(hidden) == 0 {
				return
			}
			collapsed.Lines = append(collapsed.Lines, DiffLine{
				Kind:   "collapsed",
				Text:   fmt.Sprintf("%d unchanged %s", len(hidden), pluralize("line", len(hidden))),
				Hidden: hidden,
			})
		}

		for hunkIndex, hunk := range fileHunks {
			if hunkIndex == 0 {
				firstStart, _ := hunkVisibleRange(hunk, useOldSide)
				if firstStart > 1 {
					appendCollapsedLines(contextLinesFromContent(content, 1, firstStart-1, useOldSide))
				}
			}
			if hunkIndex > 0 {
				_, previousEnd := hunkVisibleRange(fileHunks[hunkIndex-1], useOldSide)
				nextStart, _ := hunkVisibleRange(hunk, useOldSide)
				if previousEnd > 0 && nextStart > 0 {
					hidden := contextLinesFromContent(content, previousEnd+1, nextStart-1, useOldSide)
					appendCollapsedLines(hidden)
				}
			}
			collapsed.Lines = append(collapsed.Lines, hunk.Lines...)
			if hunkIndex == len(fileHunks)-1 {
				_, lastEnd := hunkVisibleRange(hunk, useOldSide)
				if lastEnd > 0 {
					appendCollapsedLines(contextLinesFromContent(content, lastEnd+1, len(content), useOldSide))
				}
			}
		}

		files = append(files, collapsed)
		index = end
	}

	return files
}

func (file FileDiff) filenameKey() string {
	if file.Filename != "" {
		return file.Filename
	}
	return file.OldPath
}

func pluralize(word string, count int) string {
	if count == 1 {
		return word
	}
	return word + "s"
}

func readGitFileLines(project Project, ref, filename string) []string {
	if ref == "" || filename == "" {
		return nil
	}

	output, err := gitInProject(project, "show", ref+":"+filename)
	if err != nil {
		return nil
	}
	output = strings.TrimSuffix(output, "\n")
	if output == "" {
		return []string{}
	}
	return strings.Split(output, "\n")
}

func hunkVisibleRange(hunk FileDiff, oldSide bool) (int, int) {
	start := 0
	end := 0
	for _, line := range hunk.Lines {
		lineNumber := line.NewLine
		if oldSide {
			lineNumber = line.OldLine
		}
		if lineNumber == 0 {
			continue
		}
		if start == 0 || lineNumber < start {
			start = lineNumber
		}
		if lineNumber > end {
			end = lineNumber
		}
	}
	return start, end
}

func contextLinesFromContent(content []string, start, end int, oldSide bool) []DiffLine {
	if start > end || len(content) == 0 {
		return nil
	}
	if start < 1 {
		start = 1
	}
	if end > len(content) {
		end = len(content)
	}
	if start > end {
		return nil
	}

	lines := make([]DiffLine, 0, end-start+1)
	for lineNumber := start; lineNumber <= end; lineNumber++ {
		line := DiffLine{
			Kind: "context",
			Text: content[lineNumber-1],
		}
		if oldSide {
			line.OldLine = lineNumber
		} else {
			line.NewLine = lineNumber
		}
		lines = append(lines, line)
	}
	return lines
}

func parseUnifiedDiff(output string) []FileDiff {
	files := make([]FileDiff, 0)

	type fileMeta struct {
		filename string
		oldPath  string
		status   string
	}
	meta := fileMeta{status: "modified"}
	var current *FileDiff
	oldLine := 0
	newLine := 0
	hunkIndex := 0

	flushHunk := func() {
		if current != nil {
			markChangedPairs(current.Lines)
			files = append(files, *current)
			current = nil
		}
	}

	startHunk := func(header string) {
		flushHunk()
		hunkIndex++
		current = &FileDiff{
			Filename:  meta.filename,
			OldPath:   meta.oldPath,
			Status:    meta.status,
			HunkIndex: hunkIndex,
			Header:    header,
		}
	}

	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			flushHunk()
			meta = fileMeta{status: "modified"}
			oldLine = 0
			newLine = 0
			hunkIndex = 0
			continue
		}

		switch {
		case strings.HasPrefix(line, "rename from "):
			meta.oldPath = strings.TrimPrefix(line, "rename from ")
		case strings.HasPrefix(line, "rename to "):
			meta.filename = strings.TrimPrefix(line, "rename to ")
			meta.status = "renamed"
		case strings.HasPrefix(line, "new file mode "):
			meta.status = "added"
		case strings.HasPrefix(line, "deleted file mode "):
			meta.status = "deleted"
		case strings.HasPrefix(line, "--- "):
			path := diffPath(strings.TrimPrefix(line, "--- "))
			if path != "" && meta.oldPath == "" {
				meta.oldPath = path
			}
		case strings.HasPrefix(line, "+++ "):
			path := diffPath(strings.TrimPrefix(line, "+++ "))
			if path != "" {
				meta.filename = path
			} else if meta.filename == "" {
				meta.filename = meta.oldPath
			}
		case strings.HasPrefix(line, "@@ "):
			matches := diffHunkHeader.FindStringSubmatch(line)
			if len(matches) == 3 {
				oldLine, _ = strconv.Atoi(matches[1])
				newLine, _ = strconv.Atoi(matches[2])
			}
			startHunk(line)
		case current != nil && strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++"):
			current.Lines = append(current.Lines, DiffLine{Kind: "added", NewLine: newLine, Text: line[1:]})
			newLine++
		case current != nil && strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---"):
			current.Lines = append(current.Lines, DiffLine{Kind: "removed", OldLine: oldLine, Text: line[1:]})
			oldLine++
		case current != nil && strings.HasPrefix(line, " "):
			current.Lines = append(current.Lines, DiffLine{Kind: "context", OldLine: oldLine, NewLine: newLine, Text: line[1:]})
			oldLine++
			newLine++
		}
	}
	flushHunk()

	return files
}

func markChangedPairs(lines []DiffLine) {
	for index := 0; index < len(lines); {
		if lines[index].Kind != "removed" {
			index++
			continue
		}

		removedStart := index
		for index < len(lines) && lines[index].Kind == "removed" {
			index++
		}
		addedStart := index
		for index < len(lines) && lines[index].Kind == "added" {
			index++
		}
		if addedStart == index {
			continue
		}

		removedCount := addedStart - removedStart
		addedCount := index - addedStart
		pairs := min(removedCount, addedCount)
		for pair := 0; pair < pairs; pair++ {
			removedIndex := removedStart + pair
			addedIndex := addedStart + pair
			removedChange, addedChange := changedRanges(lines[removedIndex].Text, lines[addedIndex].Text)
			lines[removedIndex].Changes = removedChange
			lines[addedIndex].Changes = addedChange
		}
	}
}

func changedRanges(oldText, newText string) ([]DiffLineHighlight, []DiffLineHighlight) {
	prefix := commonPrefixLen(oldText, newText)
	oldSuffixStart := len(oldText)
	newSuffixStart := len(newText)
	for oldSuffixStart > prefix && newSuffixStart > prefix && oldText[oldSuffixStart-1] == newText[newSuffixStart-1] {
		oldSuffixStart--
		newSuffixStart--
	}

	oldChanges := highlightRange(prefix, oldSuffixStart)
	newChanges := highlightRange(prefix, newSuffixStart)
	return oldChanges, newChanges
}

func commonPrefixLen(left, right string) int {
	limit := min(len(left), len(right))
	for index := 0; index < limit; index++ {
		if left[index] != right[index] {
			return index
		}
	}
	return limit
}

func highlightRange(start, end int) []DiffLineHighlight {
	if end <= start {
		return nil
	}
	return []DiffLineHighlight{{Start: start, End: end}}
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
