package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/akaswenwilk/PatchGraph/backend/internal/projects"
)

type projectLister func() ([]projects.Project, error)
type projectFilesLoader func(projectID string) ([]string, error)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:    ":" + port,
		Handler: newMux(projectsHandler, projectFilesHandler),
	}

	log.Printf("PatchGraph backend listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server failed: %v", err)
	}
}

func newMux(listProjects projectLister, loadProjectFiles projectFilesLoader) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("PatchGraph backend is running\n"))
	})
	mux.HandleFunc("/api/projects", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		projectList, err := listProjects()
		if err != nil {
			log.Printf("failed to load projects: %v", err)
			http.Error(w, "failed to load projects", http.StatusInternalServerError)
			return
		}

		writeJSON(w, projectList)
	})
	mux.HandleFunc("/api/projects/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		projectID, ok := projectIDFromFilesRoute(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}

		files, err := loadProjectFiles(projectID)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				http.Error(w, "project not found", http.StatusNotFound)
				return
			}

			log.Printf("failed to load project files for %s: %v", projectID, err)
			http.Error(w, "failed to load project files", http.StatusInternalServerError)
			return
		}

		writeJSON(w, files)
	})

	return mux
}

func projectsHandler() ([]projects.Project, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	return projects.Discover(root)
}

func projectFilesHandler(projectID string) ([]string, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	project, err := projects.FindByID(root, projectID)
	if err != nil {
		return nil, err
	}

	return projects.ListFiles(project)
}

func projectIDFromFilesRoute(path string) (string, bool) {
	const prefix = "/api/projects/"
	const suffix = "/files"

	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", false
	}

	projectID := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	projectID = strings.Trim(projectID, "/")
	if projectID == "" || strings.Contains(projectID, "/") {
		return "", false
	}

	return projectID, true
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
	}
}
