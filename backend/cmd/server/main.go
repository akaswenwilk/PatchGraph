package main

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/akaswenwilk/PatchGraph/backend/internal/projects"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:    ":" + port,
		Handler: newMux(projectsHandler, projectHandler, fileHandler),
	}

	log.Printf("PatchGraph backend listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server failed: %v", err)
	}
}

func projectsHandler() ([]projects.Project, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	return projects.Discover(root)
}

func projectHandler(projectID string) (projects.Detail, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return projects.Detail{}, err
	}

	return projects.Get(root, projectID)
}

func fileHandler(projectID string, filename string) ([]string, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	return projects.ReadFileLines(root, projectID, filename)
}

func newMux(
	listProjects func() ([]projects.Project, error),
	getProject func(string) (projects.Detail, error),
	readFile func(string, string) ([]string, error),
) http.Handler {
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
		projectID, remainder, ok := parseProjectPath(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}

		switch {
		case remainder == "" && r.Method == http.MethodGet:
			writeProjectResponse(w, projectID, getProject)
		case remainder == "files" && r.Method == http.MethodPost:
			writeFileResponse(w, r, projectID, readFile)
		case remainder == "":
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		case remainder == "files":
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		default:
			http.NotFound(w, r)
		}
	})

	return mux
}

func writeProjectResponse(w http.ResponseWriter, projectID string, getProject func(string) (projects.Detail, error)) {
	detail, err := getProject(projectID)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "project not found", http.StatusNotFound)
			return
		}

		log.Printf("failed to load project %s: %v", projectID, err)
		http.Error(w, "failed to load project", http.StatusInternalServerError)
		return
	}

	writeJSON(w, detail)
}

func writeFileResponse(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	readFile func(string, string) ([]string, error),
) {
	defer r.Body.Close()

	var request struct {
		Filename string `json:"filename"`
	}

	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(new(struct{})); !errors.Is(err, io.EOF) {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	lines, err := readFile(projectID, request.Filename)
	if err != nil {
		switch {
		case errors.Is(err, fs.ErrNotExist):
			http.Error(w, "file not found", http.StatusNotFound)
		case errors.Is(err, projects.ErrInvalidFilePath), errors.Is(err, projects.ErrFileOutsideProject):
			http.Error(w, "file not found", http.StatusNotFound)
		default:
			log.Printf("failed to read file %s in project %s: %v", request.Filename, projectID, err)
			http.Error(w, "failed to read file", http.StatusInternalServerError)
		}
		return
	}

	writeJSON(w, lines)
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
	}
}

func parseProjectPath(path string) (string, string, bool) {
	const prefix = "/api/projects/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}

	trimmed := strings.TrimPrefix(path, prefix)
	if trimmed == "" {
		return "", "", false
	}

	parts := strings.Split(trimmed, "/")
	if len(parts) == 0 || parts[0] == "" {
		return "", "", false
	}

	projectID, err := url.PathUnescape(parts[0])
	if err != nil || projectID == "" {
		return "", "", false
	}

	if len(parts) == 1 {
		return projectID, "", true
	}
	if len(parts) == 2 && parts[1] != "" {
		return projectID, parts[1], true
	}

	return "", "", false
}
