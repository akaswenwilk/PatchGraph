package projects

import (
	"bytes"
	"fmt"
	"os/exec"
	"sort"
)

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

	sort.Strings(files)

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
