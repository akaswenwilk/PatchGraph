package projects

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

var (
	ErrInvalidFilePath    = errors.New("invalid file path")
	ErrFileOutsideProject = errors.New("file path escapes project root")
)

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
	project, err := FindByID(root, projectID)
	if err != nil {
		return nil, err
	}

	cleanFilename, err := normalizeRelativeFilePath(filename)
	if err != nil {
		return nil, err
	}

	absPath := filepath.Join(project.AbsolutePath(), cleanFilename)
	relPath, err := filepath.Rel(project.AbsolutePath(), absPath)
	if err != nil {
		return nil, err
	}
	if relPath == ".." || strings.HasPrefix(relPath, ".."+string(filepath.Separator)) {
		return nil, ErrFileOutsideProject
	}

	file, err := os.Open(absPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	return readLines(file)
}

func ListFiles(project Project) ([]string, error) {
	if err := markSafeDirectory(project.AbsolutePath()); err != nil {
		return nil, err
	}

	command := exec.Command(
		"git",
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

func markSafeDirectory(path string) error {
	command := exec.Command("git", "config", "--global", "--add", "safe.directory", path)
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("mark safe directory: %w: %s", err, bytes.TrimSpace(output))
	}

	return nil
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
