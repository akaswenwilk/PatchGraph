package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestProjectsHandlerReturnsDiscoveredProjects(t *testing.T) {
	root := t.TempDir()
	projectDir := filepath.Join(root, "PatchGraph")
	if err := os.MkdirAll(filepath.Join(projectDir, ".git"), 0o755); err != nil {
		t.Fatalf("create project marker: %v", err)
	}

	t.Setenv("PATCHGRAPH_PROJECTS_ROOT", root)

	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	resp := httptest.NewRecorder()

	projectsHandler(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("unexpected status: got %d want %d", resp.Code, http.StatusOK)
	}

	if got := resp.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("unexpected content type: got %q", got)
	}

	var projectNames []string
	if err := json.Unmarshal(resp.Body.Bytes(), &projectNames); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if len(projectNames) != 1 || projectNames[0] != "PatchGraph" {
		t.Fatalf("unexpected projects: %#v", projectNames)
	}
}

func TestProjectsHandlerRejectsNonGetRequests(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/projects", nil)
	resp := httptest.NewRecorder()

	projectsHandler(resp, req)

	if resp.Code != http.StatusMethodNotAllowed {
		t.Fatalf("unexpected status: got %d want %d", resp.Code, http.StatusMethodNotAllowed)
	}

	if got := resp.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("unexpected Allow header: got %q want %q", got, http.MethodGet)
	}
}
