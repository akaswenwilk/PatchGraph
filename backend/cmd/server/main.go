package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/akaswenwilk/patchgraph/backend/internal/projects"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("PatchGraph backend is running\n"))
	})
	mux.HandleFunc("/api/projects", projectsHandler)

	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	log.Printf("PatchGraph backend listening on %s", server.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server failed: %v", err)
	}
}

func projectsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}

	projectNames, err := projects.DiscoverNamesFromEnv()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(projectNames); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
