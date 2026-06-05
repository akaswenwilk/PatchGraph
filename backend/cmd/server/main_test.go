package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProjectsEndpointReturnsProjectNames(t *testing.T) {
	handler := newMux(func() ([]string, error) {
		return []string{"PatchGraph", "PatchGraph-frontend-rebuild"}, nil
	})

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
	})

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
	})

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
