// Package web serves the built PatchGraph frontend embedded into the backend
// binary.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strings"
)

// content is populated by the root Makefile after it builds frontend/dist.
//
//go:embed dist
var content embed.FS

func Handler() http.Handler {
	dist, err := fs.Sub(content, "dist")
	if err != nil {
		panic(err)
	}

	files := http.FileServer(http.FS(dist))
	fallback := "index.html"
	if !fileExists(dist, fallback) {
		fallback = "placeholder.html"
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		cleanPath := cleanRequestPath(r.URL.Path)
		if fileExists(dist, cleanPath) {
			files.ServeHTTP(w, r)
			return
		}

		r2 := new(http.Request)
		*r2 = *r
		r2.URL = cloneURL(r.URL)
		r2.URL.Path = "/"
		http.ServeFileFS(w, r2, dist, fallback)
	})
}

func cleanRequestPath(requestPath string) string {
	cleaned := path.Clean("/" + strings.TrimPrefix(requestPath, "/"))
	if cleaned == "/" {
		return "index.html"
	}

	return strings.TrimPrefix(cleaned, "/")
}

func fileExists(files fs.FS, name string) bool {
	info, err := fs.Stat(files, name)
	return err == nil && !info.IsDir()
}

func cloneURL(u *url.URL) *url.URL {
	copy := *u
	return &copy
}
