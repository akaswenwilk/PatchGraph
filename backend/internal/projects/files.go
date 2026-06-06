package projects

import (
	"bufio"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var (
	ErrProjectNotFound    = errors.New("project not found")
	ErrInvalidFilePath    = errors.New("invalid file path")
	ErrFileOutsideProject = errors.New("file path escapes project root")
)

type Detail struct {
	Name  string   `json:"name"`
	Files []string `json:"files"`
}

func Get(root, name string) (Detail, error) {
	projectPath, err := ResolvePath(root, name)
	if err != nil {
		return Detail{}, err
	}

	files, err := listFiles(projectPath)
	if err != nil {
		return Detail{}, err
	}

	return Detail{
		Name:  name,
		Files: files,
	}, nil
}

func ResolvePath(root, name string) (string, error) {
	projectName := strings.TrimSpace(name)
	if projectName == "" || strings.Contains(projectName, string(filepath.Separator)) {
		return "", ErrProjectNotFound
	}

	info, err := os.Stat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("projects root must be a directory")
	}

	var resolved string
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		if path == root {
			return nil
		}

		if filepath.Base(path) != projectName {
			return nil
		}

		isRepo, repoErr := isProjectDirectory(path)
		if repoErr != nil {
			return repoErr
		}
		if !isRepo {
			return nil
		}

		resolved = path
		return filepath.SkipAll
	})
	if err != nil {
		return "", err
	}
	if resolved == "" {
		return "", ErrProjectNotFound
	}

	return resolved, nil
}

func ReadFileLines(root, projectName, filename string) ([]string, error) {
	projectPath, err := ResolvePath(root, projectName)
	if err != nil {
		return nil, err
	}

	cleanFilename, err := normalizeRelativeFilePath(filename)
	if err != nil {
		return nil, err
	}

	absolutePath := filepath.Join(projectPath, cleanFilename)
	relativePath, err := filepath.Rel(projectPath, absolutePath)
	if err != nil {
		return nil, err
	}
	if relativePath == ".." || strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
		return nil, ErrFileOutsideProject
	}

	file, err := os.Open(absolutePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	return readLines(file)
}

func listFiles(projectPath string) ([]string, error) {
	files := make([]string, 0)

	err := filepath.WalkDir(projectPath, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		if entry.IsDir() {
			if path != projectPath && entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}

		if !entry.Type().IsRegular() {
			return nil
		}

		relativePath, err := filepath.Rel(projectPath, path)
		if err != nil {
			return err
		}

		files = append(files, filepath.ToSlash(relativePath))
		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Strings(files)
	return files, nil
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
