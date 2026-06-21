package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/akaswenwilk/PatchGraph/backend/internal/lsp"
	"github.com/akaswenwilk/PatchGraph/backend/internal/projects"
	"github.com/akaswenwilk/PatchGraph/backend/internal/web"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "start":
		if err := start(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	case "-h", "--help", "help":
		usage()
	default:
		log.Printf("unknown command %q", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func start(args []string) error {
	flags := flag.NewFlagSet("start", flag.ExitOnError)
	port := flags.String("port", envWithDefault("PORT", "8080"), "HTTP port to listen on")
	projectsRoot := flags.String("projects", defaultProjectsRoot(), "directory containing local git projects")
	if err := flags.Parse(args); err != nil {
		return err
	}

	if strings.TrimSpace(*projectsRoot) != "" {
		if err := os.Setenv(projects.RootEnvVar, *projectsRoot); err != nil {
			return err
		}
	}

	server := &http.Server{
		Addr:    ":" + *port,
		Handler: newMux(projectsHandler, projectHandler, fileHandler, lspHandler, gitHandler, gitCheckoutHandler),
	}

	log.Printf("PatchGraph backend listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server failed: %w", err)
	}

	return nil
}

func usage() {
	_, _ = fmt.Fprintf(os.Stderr, `Usage:
  patchgraph start [--port 8080] [--projects ~/projects]

Environment:
  PORT                       default port when --port is omitted
  %s      default projects root when --projects is omitted
`, projects.RootEnvVar)
}

func envWithDefault(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}

	return value
}

func defaultProjectsRoot() string {
	if root := strings.TrimSpace(os.Getenv(projects.RootEnvVar)); root != "" {
		return root
	}

	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}

	return home + string(os.PathSeparator) + "projects"
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

func gitHandler(projectID string) (projects.GitInfo, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return projects.GitInfo{}, err
	}

	return projects.GetGitInfo(root, projectID)
}

func gitCheckoutHandler(projectID string, branch string) (projects.GitInfo, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return projects.GitInfo{}, err
	}

	return projects.CheckoutBranch(root, projectID, branch)
}

func fileHandler(projectID string, filename string) ([]string, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	return projects.ReadFileLines(root, projectID, filename)
}

// lspDefaultTimeout bounds a single LSP analysis. Cold language server startup
// and indexing can be slow, so it is generous.
const lspDefaultTimeout = 90 * time.Second

func lspHandler(projectID string, filename string) (lsp.FileAnalysis, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return lsp.FileAnalysis{}, err
	}

	command, languageID, ok := lsp.LanguageForFile(filename)
	if !ok {
		return lsp.FileAnalysis{}, lsp.ErrUnsupportedLanguage
	}

	project, absPath, err := projects.ResolveFile(root, projectID, filename)
	if err != nil {
		return lsp.FileAnalysis{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), lspDefaultTimeout)
	defer cancel()

	return lsp.Analyze(ctx, project.AbsolutePath(), absPath, languageID, command)
}

func newMux(
	listProjects func() ([]projects.Project, error),
	getProject func(string) (projects.Detail, error),
	readFile func(string, string) ([]string, error),
	analyzeFile func(string, string) (lsp.FileAnalysis, error),
	getGitInfo func(string) (projects.GitInfo, error),
	checkoutBranch func(string, string) (projects.GitInfo, error),
) http.Handler {
	mux := http.NewServeMux()
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
		case remainder == "lsp" && r.Method == http.MethodPost:
			writeLSPResponse(w, r, projectID, analyzeFile)
		case remainder == "git" && r.Method == http.MethodGet:
			writeGitResponse(w, projectID, getGitInfo)
		case remainder == "git" && r.Method == http.MethodPost:
			writeGitCheckoutResponse(w, r, projectID, checkoutBranch)
		case remainder == "":
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		case remainder == "git":
			w.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		case remainder == "files", remainder == "lsp":
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		default:
			http.NotFound(w, r)
		}
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	mux.Handle("/", web.Handler())

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

func writeGitResponse(w http.ResponseWriter, projectID string, getGitInfo func(string) (projects.GitInfo, error)) {
	info, err := getGitInfo(projectID)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "project not found", http.StatusNotFound)
			return
		}

		log.Printf("failed to load git info for project %s: %v", projectID, err)
		http.Error(w, "failed to load git info", http.StatusInternalServerError)
		return
	}

	writeJSON(w, info)
}

func writeGitCheckoutResponse(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	checkoutBranch func(string, string) (projects.GitInfo, error),
) {
	defer r.Body.Close()

	var request struct {
		Branch string `json:"branch"`
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
	if strings.TrimSpace(request.Branch) == "" {
		http.Error(w, "branch is required", http.StatusBadRequest)
		return
	}

	info, err := checkoutBranch(projectID, request.Branch)
	if err != nil {
		switch {
		case errors.Is(err, fs.ErrNotExist):
			http.Error(w, "project not found", http.StatusNotFound)
		case errors.Is(err, projects.ErrBranchNotFound):
			http.Error(w, "branch not found", http.StatusNotFound)
		case errors.Is(err, projects.ErrUncommittedChanges):
			http.Error(
				w,
				"You have uncommitted changes. Stash, commit, or discard them before switching branches.",
				http.StatusConflict,
			)
		default:
			log.Printf("failed to checkout branch %q in project %s: %v", request.Branch, projectID, err)
			http.Error(w, "failed to switch branch", http.StatusInternalServerError)
		}
		return
	}

	writeJSON(w, info)
}

func writeFileResponse(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	readFile func(string, string) ([]string, error),
) {
	filename, ok := decodeFilenameRequest(w, r)
	if !ok {
		return
	}

	lines, err := readFile(projectID, filename)
	if err != nil {
		switch {
		case errors.Is(err, fs.ErrNotExist):
			http.Error(w, "file not found", http.StatusNotFound)
		case errors.Is(err, projects.ErrInvalidFilePath), errors.Is(err, projects.ErrFileOutsideProject):
			http.Error(w, "file not found", http.StatusNotFound)
		default:
			log.Printf("failed to read file %s in project %s: %v", filename, projectID, err)
			http.Error(w, "failed to read file", http.StatusInternalServerError)
		}
		return
	}

	writeJSON(w, lines)
}

func writeLSPResponse(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	analyzeFile func(string, string) (lsp.FileAnalysis, error),
) {
	filename, ok := decodeFilenameRequest(w, r)
	if !ok {
		return
	}

	analysis, err := analyzeFile(projectID, filename)
	if err != nil {
		switch {
		case errors.Is(err, fs.ErrNotExist),
			errors.Is(err, projects.ErrInvalidFilePath),
			errors.Is(err, projects.ErrFileOutsideProject):
			http.Error(w, "file not found", http.StatusNotFound)
		case errors.Is(err, lsp.ErrUnsupportedLanguage):
			http.Error(w, "unsupported file type", http.StatusBadRequest)
		case errors.Is(err, lsp.ErrServerUnavailable):
			http.Error(w, "language server unavailable", http.StatusServiceUnavailable)
		default:
			log.Printf("failed to analyze file %s in project %s: %v", filename, projectID, err)
			http.Error(w, "failed to analyze file", http.StatusInternalServerError)
		}
		return
	}

	writeJSON(w, analysis)
}

// decodeFilenameRequest reads the shared {"filename": "..."} POST body. On a
// malformed body it writes a 400 response and returns ok=false.
func decodeFilenameRequest(w http.ResponseWriter, r *http.Request) (string, bool) {
	defer r.Body.Close()

	var request struct {
		Filename string `json:"filename"`
	}

	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return "", false
	}
	if err := decoder.Decode(new(struct{})); !errors.Is(err, io.EOF) {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return "", false
	}

	return request.Filename, true
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
