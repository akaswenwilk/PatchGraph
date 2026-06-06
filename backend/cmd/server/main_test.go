package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akaswenwilk/PatchGraph/backend/internal/projects"
)

func TestProjectsEndpointReturnsProjectNames(t *testing.T) {
	handler := newMux(func() ([]string, error) {
		return []string{"PatchGraph", "PatchGraph-frontend-rebuild"}, nil
	}, nil, nil)

	request := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.Contains(contentType, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}
	if body := strings.TrimSpace(recorder.Body.String()); body != "[\"PatchGraph\",\"PatchGraph-frontend-rebuild\"]" {
		t.Fatalf("body = %q", body)
	}
}

func TestProjectsEndpointReturnsInternalServerError(t *testing.T) {
	handler := newMux(func() ([]string, error) {
		return nil, errors.New("boom")
	}, nil, nil)

	request := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
}

func TestProjectsEndpointRejectsPost(t *testing.T) {
	handler := newMux(func() ([]string, error) {
		return []string{"PatchGraph"}, nil
	}, nil, nil)

	request := httptest.NewRequest(http.MethodPost, "/api/projects", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodGet {
		t.Fatalf("Allow = %q, want %q", allow, http.MethodGet)
	}
}

func TestProjectEndpointReturnsFiles(t *testing.T) {
	handler := newMux(
		func() ([]string, error) { return nil, nil },
		func(projectID string) (projects.Detail, error) {
			if projectID != "PatchGraph" {
				t.Fatalf("projectID = %q, want %q", projectID, "PatchGraph")
			}
			return projects.Detail{
				Name:  "PatchGraph",
				Files: []string{"README.md", "frontend/src/App.tsx"},
			}, nil
		},
		nil,
	)

	request := httptest.NewRequest(http.MethodGet, "/api/projects/PatchGraph", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if body := strings.TrimSpace(recorder.Body.String()); body != "{\"name\":\"PatchGraph\",\"files\":[\"README.md\",\"frontend/src/App.tsx\"]}" {
		t.Fatalf("body = %q", body)
	}
}

func TestProjectEndpointReturnsNotFound(t *testing.T) {
	handler := newMux(
		func() ([]string, error) { return nil, nil },
		func(projectID string) (projects.Detail, error) {
			return projects.Detail{}, projects.ErrProjectNotFound
		},
		nil,
	)

	request := httptest.NewRequest(http.MethodGet, "/api/projects/missing", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}

func TestProjectFileEndpointReturnsLines(t *testing.T) {
	handler := newMux(
		func() ([]string, error) { return nil, nil },
		nil,
		func(projectID string, filename string) ([]string, error) {
			if projectID != "PatchGraph" {
				t.Fatalf("projectID = %q, want %q", projectID, "PatchGraph")
			}
			if filename != "frontend/src/App.tsx" {
				t.Fatalf("filename = %q, want %q", filename, "frontend/src/App.tsx")
			}
			return []string{"line 1", "\tline 2"}, nil
		},
	)

	body, err := json.Marshal(map[string]string{"filename": "frontend/src/App.tsx"})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/projects/PatchGraph/files", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if body := strings.TrimSpace(recorder.Body.String()); body != "[\"line 1\",\"\\tline 2\"]" {
		t.Fatalf("body = %q", body)
	}
}

func TestProjectFileEndpointRejectsInvalidBody(t *testing.T) {
	handler := newMux(
		func() ([]string, error) { return nil, nil },
		nil,
		func(projectID string, filename string) ([]string, error) {
			return nil, nil
		},
	)

	request := httptest.NewRequest(http.MethodPost, "/api/projects/PatchGraph/files", strings.NewReader("{"))
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}
