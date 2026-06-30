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
	configPath := flags.String("config", envWithDefault(lsp.ConfigEnvVar, ""), "YAML config file for language servers")
	if err := flags.Parse(args); err != nil {
		return err
	}

	if strings.TrimSpace(*projectsRoot) != "" {
		if err := os.Setenv(projects.RootEnvVar, *projectsRoot); err != nil {
			return err
		}
	}

	lspConfig, err := lsp.LoadConfig(*configPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	analyzeFile := func(projectID string, filename string) (lsp.FileAnalysis, error) {
		return lspHandlerWithConfig(lspConfig, projectID, filename)
	}

	server := &http.Server{
		Addr:    ":" + *port,
		Handler: newMux(projectsHandler, projectHandler, fileHandler, searchHandler, analyzeFile, branchesHandler, branchActionHandler, branchCompareHandler),
	}

	log.Printf("PatchGraph backend listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server failed: %w", err)
	}

	return nil
}

func usage() {
	_, _ = fmt.Fprintf(os.Stderr, `Usage:
  patchgraph start [--port 8080] [--projects ~/projects] [--config ~/.config/patchgraph/config.yaml]

Environment:
  PORT                       default port when --port is omitted
  %s      default projects root when --projects is omitted
  %s        default YAML config path when --config is omitted
`, projects.RootEnvVar, lsp.ConfigEnvVar)
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

func fileHandler(projectID string, filename string) ([]string, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	return projects.ReadFileLines(root, projectID, filename)
}

func searchHandler(projectID string, query string) ([]projects.SearchMatch, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	return projects.SearchText(root, projectID, query)
}

func branchesHandler(projectID string) ([]projects.Branch, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	return projects.ListBranches(root, projectID)
}

func branchActionHandler(projectID string, action projects.BranchAction) ([]projects.Branch, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	return projects.PerformBranchAction(root, projectID, action)
}

func branchCompareHandler(projectID string, base string, compare string) (projects.BranchComparison, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return projects.BranchComparison{}, err
	}

	return projects.CompareBranches(root, projectID, base, compare)
}

// lspDefaultTimeout bounds a single LSP analysis. Cold language server startup
// and indexing can be slow, so it is generous.
const lspDefaultTimeout = 90 * time.Second

func lspHandler(projectID string, filename string) (lsp.FileAnalysis, error) {
	return lspHandlerWithConfig(lsp.DefaultConfig(), projectID, filename)
}

func lspHandlerWithConfig(config lsp.Config, projectID string, filename string) (lsp.FileAnalysis, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return lsp.FileAnalysis{}, err
	}

	command, languageID, serverConfig, ok := lsp.LanguageForFileWithConfig(filename, config)
	if !ok {
		return lsp.FileAnalysis{}, lsp.ErrUnsupportedLanguage
	}

	project, absPath, err := projects.ResolveFile(root, projectID, filename)
	if err != nil {
		return lsp.FileAnalysis{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), lspDefaultTimeout)
	defer cancel()

	return lsp.AnalyzeWithConfig(ctx, project.AbsolutePath(), absPath, languageID, command, serverConfig)
}

func newMux(
	listProjects func() ([]projects.Project, error),
	getProject func(string) (projects.Detail, error),
	readFile func(string, string) ([]string, error),
	searchText func(string, string) ([]projects.SearchMatch, error),
	analyzeFile func(string, string) (lsp.FileAnalysis, error),
	listBranches func(string) ([]projects.Branch, error),
	branchAction func(string, projects.BranchAction) ([]projects.Branch, error),
	compareBranches ...func(string, string, string) (projects.BranchComparison, error),
) http.Handler {
	mux := http.NewServeMux()
	var compareBranchHandler func(string, string, string) (projects.BranchComparison, error)
	if len(compareBranches) > 0 {
		compareBranchHandler = compareBranches[0]
	}
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
		case remainder == "search" && r.Method == http.MethodPost:
			writeSearchResponse(w, r, projectID, searchText)
		case remainder == "lsp" && r.Method == http.MethodPost:
			writeLSPResponse(w, r, projectID, analyzeFile)
		case remainder == "branches" && r.Method == http.MethodGet:
			writeBranchesResponse(w, projectID, listBranches)
		case remainder == "branches" && r.Method == http.MethodPost:
			writeBranchActionResponse(w, r, projectID, branchAction)
		case remainder == "branch-diff" && r.Method == http.MethodPost:
			writeBranchCompareResponse(w, r, projectID, compareBranchHandler)
		case remainder == "":
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		case remainder == "files", remainder == "search", remainder == "lsp", remainder == "branch-diff":
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		case remainder == "branches":
			w.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
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

func writeSearchResponse(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	searchText func(string, string) ([]projects.SearchMatch, error),
) {
	query, ok := decodeQueryRequest(w, r)
	if !ok {
		return
	}

	matches, err := searchText(projectID, query)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "project not found", http.StatusNotFound)
			return
		}

		log.Printf("failed to search project %s: %v", projectID, err)
		http.Error(w, "failed to search project", http.StatusInternalServerError)
		return
	}

	writeJSON(w, matches)
}

func writeBranchesResponse(
	w http.ResponseWriter,
	projectID string,
	listBranches func(string) ([]projects.Branch, error),
) {
	branches, err := listBranches(projectID)
	if err != nil {
		writeBranchError(w, projectID, err, "failed to list branches")
		return
	}

	writeJSON(w, branches)
}

func writeBranchActionResponse(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	branchAction func(string, projects.BranchAction) ([]projects.Branch, error),
) {
	action, ok := decodeBranchAction(w, r)
	if !ok {
		return
	}

	branches, err := branchAction(projectID, action)
	if err != nil {
		if errors.Is(err, projects.ErrInvalidBranchName) || errors.Is(err, projects.ErrUnknownBranchAction) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		writeBranchError(w, projectID, err, "branch action failed")
		return
	}

	writeJSON(w, branches)
}

func writeBranchCompareResponse(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	compareBranches func(string, string, string) (projects.BranchComparison, error),
) {
	if compareBranches == nil {
		http.Error(w, "branch comparison unavailable", http.StatusInternalServerError)
		return
	}

	request, ok := decodeBranchCompareRequest(w, r)
	if !ok {
		return
	}

	comparison, err := compareBranches(projectID, request.Base, request.Compare)
	if err != nil {
		if errors.Is(err, projects.ErrInvalidBranchName) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		writeBranchError(w, projectID, err, "branch comparison failed")
		return
	}

	writeJSON(w, comparison)
}

// writeBranchError maps a branch operation error to a response: a missing
// project is 404, a git failure (uncommitted changes, unmerged branch, merge
// conflict) is 409 with git's own message as JSON so the UI can show it, and
// anything else is a logged 500.
func writeBranchError(w http.ResponseWriter, projectID string, err error, logPrefix string) {
	if errors.Is(err, fs.ErrNotExist) {
		http.Error(w, "project not found", http.StatusNotFound)
		return
	}

	var gitErr *projects.GitError
	if errors.As(err, &gitErr) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": gitErr.Message})
		return
	}

	log.Printf("%s for project %s: %v", logPrefix, projectID, err)
	http.Error(w, logPrefix, http.StatusInternalServerError)
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

// decodeQueryRequest reads the {"query": "..."} POST body used by text search.
// On a malformed body it writes a 400 response and returns ok=false.
func decodeQueryRequest(w http.ResponseWriter, r *http.Request) (string, bool) {
	defer r.Body.Close()

	var request struct {
		Query string `json:"query"`
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

	return request.Query, true
}

// decodeBranchAction reads the branch mutation POST body. On a malformed body
// it writes a 400 response and returns ok=false.
func decodeBranchAction(w http.ResponseWriter, r *http.Request) (projects.BranchAction, bool) {
	defer r.Body.Close()

	var request projects.BranchAction

	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return projects.BranchAction{}, false
	}
	if err := decoder.Decode(new(struct{})); !errors.Is(err, io.EOF) {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return projects.BranchAction{}, false
	}

	return request, true
}

type branchCompareRequest struct {
	Base    string `json:"base"`
	Compare string `json:"compare"`
}

func decodeBranchCompareRequest(w http.ResponseWriter, r *http.Request) (branchCompareRequest, bool) {
	defer r.Body.Close()

	var request branchCompareRequest

	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return branchCompareRequest{}, false
	}
	if err := decoder.Decode(new(struct{})); !errors.Is(err, io.EOF) {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return branchCompareRequest{}, false
	}

	return request, true
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
