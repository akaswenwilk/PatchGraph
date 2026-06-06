package projects

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestGetReturnsSortedRelativeFiles(t *testing.T) {
	root := t.TempDir()
	projectPath := filepath.Join(root, "PatchGraph")
	createGitDir(t, projectPath)
	mustWriteFile(t, filepath.Join(projectPath, "README.md"), "# PatchGraph\n")
	mustWriteFile(t, filepath.Join(projectPath, "frontend", "src", "App.tsx"), "export {}\n")
	mustWriteFile(t, filepath.Join(projectPath, ".git", "ignored.txt"), "ignore\n")

	detail, err := Get(root, "PatchGraph")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}

	if detail.Name != "PatchGraph" {
		t.Fatalf("detail.Name = %q, want %q", detail.Name, "PatchGraph")
	}

	want := []string{"README.md", "frontend/src/App.tsx"}
	if !reflect.DeepEqual(detail.Files, want) {
		t.Fatalf("detail.Files = %v, want %v", detail.Files, want)
	}
}

func TestReadFileLinesReturnsEachLineWithoutTrailingNewline(t *testing.T) {
	root := t.TempDir()
	projectPath := filepath.Join(root, "PatchGraph")
	createGitDir(t, projectPath)
	mustWriteFile(t, filepath.Join(projectPath, "notes.txt"), "first\n\tsecond\nthird")

	lines, err := ReadFileLines(root, "PatchGraph", "notes.txt")
	if err != nil {
		t.Fatalf("ReadFileLines() error = %v", err)
	}

	want := []string{"first", "\tsecond", "third"}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %v, want %v", lines, want)
	}
}

func TestReadFileLinesRejectsEscapingPaths(t *testing.T) {
	root := t.TempDir()
	projectPath := filepath.Join(root, "PatchGraph")
	createGitDir(t, projectPath)

	_, err := ReadFileLines(root, "PatchGraph", "../secret.txt")
	if !errors.Is(err, ErrInvalidFilePath) {
		t.Fatalf("ReadFileLines() error = %v, want %v", err, ErrInvalidFilePath)
	}
}

func TestResolvePathReturnsProjectNotFoundForMissingProject(t *testing.T) {
	root := t.TempDir()
	createGitDir(t, filepath.Join(root, "alpha"))

	_, err := ResolvePath(root, "missing")
	if !errors.Is(err, ErrProjectNotFound) {
		t.Fatalf("ResolvePath() error = %v, want %v", err, ErrProjectNotFound)
	}
}

func mustWriteFile(t *testing.T, path string, content string) {
	t.Helper()
	mustMkdirAll(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", path, err)
	}
}

func TestReadLinesHandlesEmptyFinalLine(t *testing.T) {
	lines, err := readLines(strings.NewReader("alpha\n\n"))
	if err != nil {
		t.Fatalf("readLines() error = %v", err)
	}

	want := []string{"alpha", ""}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("lines = %v, want %v", lines, want)
	}
}
