package projects

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

var (
	ErrInvalidFilePath    = errors.New("invalid file path")
	ErrFileOutsideProject = errors.New("file path escapes project root")
)

// SearchMatch is a single line in a project file that contains the query text.
type SearchMatch struct {
	Filename string `json:"filename"`
	Line     int    `json:"line"`
	Text     string `json:"text"`
}

// maxSearchMatches caps how many matches a single text search returns so a
// broad query against a large repo cannot flood the response or the UI.
const maxSearchMatches = 200

// maxSearchTextLen truncates each returned line so a single very long line
// (e.g. minified code) does not bloat the payload.
const maxSearchTextLen = 400

type Detail struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Path  string   `json:"path"`
	Files []string `json:"files"`
}

func Get(root, id string) (Detail, error) {
	project, err := FindByID(root, id)
	if err != nil {
		return Detail{}, err
	}

	files, err := ListFiles(project)
	if err != nil {
		return Detail{}, err
	}

	return Detail{
		ID:    project.ID,
		Name:  project.Name,
		Path:  project.Path,
		Files: files,
	}, nil
}

func ReadFileLines(root, projectID, filename string) ([]string, error) {
	_, absPath, err := ResolveFile(root, projectID, filename)
	if err != nil {
		return nil, err
	}

	file, err := os.Open(absPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	return readLines(file)
}

// ResolveFile locates a project and returns the validated absolute path to a
// file within it. The path is guaranteed not to escape the project root.
func ResolveFile(root, projectID, filename string) (Project, string, error) {
	project, err := FindByID(root, projectID)
	if err != nil {
		return Project{}, "", err
	}

	cleanFilename, err := normalizeRelativeFilePath(filename)
	if err != nil {
		return Project{}, "", err
	}

	absPath := filepath.Join(project.AbsolutePath(), cleanFilename)
	relPath, err := filepath.Rel(project.AbsolutePath(), absPath)
	if err != nil {
		return Project{}, "", err
	}
	if relPath == ".." || strings.HasPrefix(relPath, ".."+string(filepath.Separator)) {
		return Project{}, "", ErrFileOutsideProject
	}

	if _, err := os.Stat(absPath); err != nil {
		return Project{}, "", err
	}

	return project, absPath, nil
}

func ListFiles(project Project) ([]string, error) {
	// Mark the directory safe per-invocation with -c rather than mutating the
	// global git config. The latter races on the global config lock when
	// projects are listed concurrently ("could not lock config file").
	command := exec.Command(
		"git",
		"-c",
		"safe.directory="+project.AbsolutePath(),
		"-C",
		project.AbsolutePath(),
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
		"-z",
	)

	output, err := command.Output()
	if err != nil {
		return nil, err
	}

	entries := bytes.Split(output, []byte{0})
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if len(entry) == 0 {
			continue
		}

		filePath := string(entry)
		if filePath == "" {
			continue
		}

		files = append(files, filePath)
	}

	slices.Sort(files)
	return files, nil
}

// SearchText runs a case-insensitive, fixed-string search for query across the
// same files the explorer lists (tracked plus non-ignored untracked) using
// `git grep`, returning up to maxSearchMatches matching lines. An empty query
// (or one with no matches) yields an empty slice, not an error.
func SearchText(root, projectID, query string) ([]SearchMatch, error) {
	project, err := FindByID(root, projectID)
	if err != nil {
		return nil, err
	}

	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return []SearchMatch{}, nil
	}

	// Mark the directory safe per-invocation with -c rather than mutating the
	// global git config (mirrors ListFiles, avoiding the global config lock).
	// -z separates the filename, line number, and text with NUL so colons in
	// any field don't break parsing; --untracked matches the explorer's file
	// set; -I skips binary files; -F -i make it a case-insensitive literal.
	command := exec.Command(
		"git",
		"-c", "safe.directory="+project.AbsolutePath(),
		"-C", project.AbsolutePath(),
		"grep",
		"--no-color",
		"-z",
		"-n",
		"-I",
		"--untracked",
		"-i",
		"-F",
		"-e", trimmed,
		"--",
	)

	output, err := command.Output()
	if err != nil {
		// git grep exits 1 when there are simply no matches; that is not an error.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return []SearchMatch{}, nil
		}
		return nil, err
	}

	return parseGrepMatches(output), nil
}

// parseGrepMatches decodes `git grep -z -n` output into matches. Each record is
// newline-terminated and holds NUL-separated filename, line number, and text.
func parseGrepMatches(output []byte) []SearchMatch {
	matches := make([]SearchMatch, 0)
	for _, record := range bytes.Split(output, []byte{'\n'}) {
		if len(record) == 0 {
			continue
		}

		fields := bytes.SplitN(record, []byte{0}, 3)
		if len(fields) != 3 {
			continue
		}

		line, err := strconv.Atoi(string(fields[1]))
		if err != nil {
			continue
		}

		text := string(fields[2])
		if len(text) > maxSearchTextLen {
			text = text[:maxSearchTextLen]
		}

		matches = append(matches, SearchMatch{
			Filename: string(fields[0]),
			Line:     line,
			Text:     text,
		})
		if len(matches) >= maxSearchMatches {
			break
		}
	}

	return matches
}

func normalizeRelativeFilePath(filename string) (string, error) {
	trimmed := strings.TrimSpace(filename)
	if trimmed == "" {
		return "", ErrInvalidFilePath
	}

	slashed := filepath.FromSlash(trimmed)
	if filepath.IsAbs(slashed) {
		return "", ErrInvalidFilePath
	}

	clean := filepath.Clean(slashed)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", ErrInvalidFilePath
	}

	return clean, nil
}

func readLines(reader io.Reader) ([]string, error) {
	buffered := bufio.NewReader(reader)
	lines := make([]string, 0)

	for {
		line, err := buffered.ReadString('\n')
		if errors.Is(err, io.EOF) {
			if len(line) > 0 {
				lines = append(lines, strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"))
			}
			return lines, nil
		}
		if err != nil {
			return nil, err
		}

		lines = append(lines, strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"))
	}
}
