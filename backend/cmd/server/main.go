package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"

	"github.com/akaswenwilk/PatchGraph/backend/internal/projects"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:    ":" + port,
		Handler: newMux(projectsHandler),
	}

	log.Printf("PatchGraph backend listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server failed: %v", err)
	}
}

func newMux(listProjects func() ([]string, error)) http.Handler {
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

		projectNames, err := listProjects()
		if err != nil {
			http.Error(w, "failed to load projects", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(projectNames); err != nil {
			http.Error(w, "failed to encode projects", http.StatusInternalServerError)
		}
	})

	return mux
}

func projectsHandler() ([]string, error) {
	root, err := projects.RootFromEnv()
	if err != nil {
		return nil, err
	}

	return projects.Discover(root)
}
