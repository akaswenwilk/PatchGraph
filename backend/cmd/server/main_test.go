package main

import (
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
	}, nil)

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

func TestProjectsFilesEndpointReturnsFiles(t *testing.T) {
	handler := newMux(func() ([]projects.Project, error) {
		return nil, nil
	}, func(projectID string) ([]string, error) {
		if projectID != "alpha" {
			t.Fatalf("projectID = %q, want %q", projectID, "alpha")
		}
		return []string{"README.md", "frontend/src/App.tsx"}, nil
	})

	request := httptest.NewRequest(http.MethodGet, "/api/projects/alpha/files", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	body := strings.TrimSpace(recorder.Body.String())
	if body != "[\"README.md\",\"frontend/src/App.tsx\"]" {
		t.Fatalf("body = %q", body)
	}
}

func TestProjectsFilesEndpointReturnsNotFound(t *testing.T) {
	handler := newMux(func() ([]projects.Project, error) {
		return nil, nil
	}, func(projectID string) ([]string, error) {
		return nil, errors.New("file loader")
	})

	request := httptest.NewRequest(http.MethodGet, "/api/projects/alpha", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}

func TestProjectsFilesEndpointReturnsProjectNotFound(t *testing.T) {
	handler := newMux(func() ([]projects.Project, error) {
		return nil, nil
	}, func(projectID string) ([]string, error) {
		return nil, fs.ErrNotExist
	})

	request := httptest.NewRequest(http.MethodGet, "/api/projects/missing/files", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}

func TestProjectsFilesEndpointRejectsPost(t *testing.T) {
	handler := newMux(func() ([]projects.Project, error) {
		return nil, nil
	}, func(projectID string) ([]string, error) {
		return nil, nil
	})

	request := httptest.NewRequest(http.MethodPost, "/api/projects/alpha/files", nil)
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodGet {
		t.Fatalf("Allow = %q, want %q", allow, http.MethodGet)
	}
}

func TestProjectsEndpointReturnsInternalServerError(t *testing.T) {
	handler := newMux(func() ([]projects.Project, error) {
		return nil, errors.New("boom")
	}, nil)

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
	}, nil)

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

func TestProjectIDFromFilesRoute(t *testing.T) {
	projectID, ok := projectIDFromFilesRoute("/api/projects/abc123/files")
	if !ok {
		t.Fatal("projectIDFromFilesRoute() = false, want true")
	}
	if projectID != "abc123" {
		t.Fatalf("projectID = %q, want %q", projectID, "abc123")
	}
}
