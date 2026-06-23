package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akaswenwilk/PatchGraph/backend/internal/projects"
)

func TestProjectsEndpointReturnsProjects(t *testing.T) {
	handler := newMux(func() ([]projects.Project, error) {
		return []projects.Project{
			{ID: "alpha", Name: "PatchGraph", Path: "PatchGraph"},
			{ID: "beta", Name: "PatchGraph", Path: "team/PatchGraph"},
		}, nil
	}, nil, nil, nil, nil)

	request := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.Contains(contentType, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}
	body := strings.TrimSpace(recorder.Body.String())
	want := "[{\"id\":\"alpha\",\"name\":\"PatchGraph\",\"path\":\"PatchGraph\"},{\"id\":\"beta\",\"name\":\"PatchGraph\",\"path\":\"team/PatchGraph\"}]"
	if body != want {
		t.Fatalf("body = %q, want %q", body, want)
	}
}

func TestProjectsEndpointReturnsInternalServerError(t *testing.T) {
	handler := newMux(func() ([]projects.Project, error) {
		return nil, errors.New("boom")
	}, nil, nil, nil, nil)

	request := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
}

func TestProjectsEndpointRejectsPost(t *testing.T) {
	handler := newMux(func() ([]projects.Project, error) {
		return []projects.Project{{ID: "alpha", Name: "PatchGraph", Path: "PatchGraph"}}, nil
	}, nil, nil, nil, nil)

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

func TestRootServesFrontend(t *testing.T) {
	handler := newMux(nil, nil, nil, nil, nil)

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if body := recorder.Body.String(); !strings.Contains(body, "PatchGraph") {
		t.Fatalf("body = %q, want embedded frontend content", body)
	}
}

func TestUnknownAPIRouteReturnsNotFound(t *testing.T) {
	handler := newMux(nil, nil, nil, nil, nil)

	request := httptest.NewRequest(http.MethodGet, "/api/unknown", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}

func TestProjectEndpointReturnsDetail(t *testing.T) {
	handler := newMux(
		func() ([]projects.Project, error) { return nil, nil },
		func(projectID string) (projects.Detail, error) {
			if projectID != "alpha" {
				t.Fatalf("projectID = %q, want %q", projectID, "alpha")
			}
			return projects.Detail{
				ID:    "alpha",
				Name:  "PatchGraph",
				Path:  "PatchGraph",
				Files: []string{"README.md", "frontend/src/App.tsx"},
			}, nil
		},
		nil,
		nil,
		nil,
	)

	request := httptest.NewRequest(http.MethodGet, "/api/projects/alpha", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	body := strings.TrimSpace(recorder.Body.String())
	want := "{\"id\":\"alpha\",\"name\":\"PatchGraph\",\"path\":\"PatchGraph\",\"files\":[\"README.md\",\"frontend/src/App.tsx\"]}"
	if body != want {
		t.Fatalf("body = %q, want %q", body, want)
	}
}

func TestProjectEndpointReturnsNotFound(t *testing.T) {
	handler := newMux(
		func() ([]projects.Project, error) { return nil, nil },
		func(projectID string) (projects.Detail, error) {
			return projects.Detail{}, fs.ErrNotExist
		},
		nil,
		nil,
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
		func() ([]projects.Project, error) { return nil, nil },
		nil,
		func(projectID string, filename string) ([]string, error) {
			if projectID != "alpha" {
				t.Fatalf("projectID = %q, want %q", projectID, "alpha")
			}
			if filename != "frontend/src/App.tsx" {
				t.Fatalf("filename = %q, want %q", filename, "frontend/src/App.tsx")
			}
			return []string{"line 1", "\tline 2"}, nil
		},
		nil,
		nil,
	)

	body, err := json.Marshal(map[string]string{"filename": "frontend/src/App.tsx"})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/projects/alpha/files", bytes.NewReader(body))
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

func TestProjectFileEndpointReturnsProjectNotFound(t *testing.T) {
	handler := newMux(
		func() ([]projects.Project, error) { return nil, nil },
		nil,
		func(projectID string, filename string) ([]string, error) {
			return nil, fs.ErrNotExist
		},
		nil,
		nil,
	)

	request := httptest.NewRequest(http.MethodPost, "/api/projects/missing/files", strings.NewReader("{\"filename\":\"README.md\"}"))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}

func TestProjectFileEndpointRejectsInvalidBody(t *testing.T) {
	handler := newMux(
		func() ([]projects.Project, error) { return nil, nil },
		nil,
		func(projectID string, filename string) ([]string, error) { return nil, nil },
		nil,
		nil,
	)

	request := httptest.NewRequest(http.MethodPost, "/api/projects/alpha/files", strings.NewReader("{"))
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestProjectFileEndpointRejectsGet(t *testing.T) {
	handler := newMux(
		func() ([]projects.Project, error) { return nil, nil },
		nil,
		func(projectID string, filename string) ([]string, error) { return nil, nil },
		nil,
		nil,
	)

	request := httptest.NewRequest(http.MethodGet, "/api/projects/alpha/files", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q, want %q", allow, http.MethodPost)
	}
}

func TestProjectSearchEndpointReturnsMatches(t *testing.T) {
	handler := newMux(
		func() ([]projects.Project, error) { return nil, nil },
		nil,
		nil,
		func(projectID string, query string) ([]projects.SearchMatch, error) {
			if projectID != "alpha" {
				t.Fatalf("projectID = %q, want %q", projectID, "alpha")
			}
			if query != "needle" {
				t.Fatalf("query = %q, want %q", query, "needle")
			}
			return []projects.SearchMatch{
				{Filename: "main.go", Line: 12, Text: "var needle = 1"},
			}, nil
		},
		nil,
	)

	request := httptest.NewRequest(http.MethodPost, "/api/projects/alpha/search", strings.NewReader("{\"query\":\"needle\"}"))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	body := strings.TrimSpace(recorder.Body.String())
	want := "[{\"filename\":\"main.go\",\"line\":12,\"text\":\"var needle = 1\"}]"
	if body != want {
		t.Fatalf("body = %q, want %q", body, want)
	}
}

func TestProjectSearchEndpointRejectsGet(t *testing.T) {
	handler := newMux(
		func() ([]projects.Project, error) { return nil, nil },
		nil,
		nil,
		func(projectID string, query string) ([]projects.SearchMatch, error) { return nil, nil },
		nil,
	)

	request := httptest.NewRequest(http.MethodGet, "/api/projects/alpha/search", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q, want %q", allow, http.MethodPost)
	}
}

func TestProjectSearchEndpointRejectsInvalidBody(t *testing.T) {
	handler := newMux(
		func() ([]projects.Project, error) { return nil, nil },
		nil,
		nil,
		func(projectID string, query string) ([]projects.SearchMatch, error) { return nil, nil },
		nil,
	)

	request := httptest.NewRequest(http.MethodPost, "/api/projects/alpha/search", strings.NewReader("{"))
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestParseProjectPath(t *testing.T) {
	projectID, remainder, ok := parseProjectPath("/api/projects/abc123/files")
	if !ok {
		t.Fatal("parseProjectPath() = false, want true")
	}
	if projectID != "abc123" || remainder != "files" {
		t.Fatalf("parseProjectPath() = (%q, %q), want (%q, %q)", projectID, remainder, "abc123", "files")
	}
}
