PREFIX ?= $(HOME)/.local
BINARY := build/patchgraph
WEB_DIST := backend/internal/web/dist

.PHONY: build install

build:
	npm --prefix frontend ci
	npm --prefix frontend run build
	rm -rf $(WEB_DIST)
	mkdir -p $(WEB_DIST)
	cp -R frontend/dist/. $(WEB_DIST)/
	printf '%s\n%s\n' 'PatchGraph frontend placeholder.' 'Run make build from the repository root to embed the production frontend build.' > $(WEB_DIST)/placeholder.html
	mkdir -p build
	cd backend && go build -o ../$(BINARY) ./cmd/server

install: build
	install -d $(PREFIX)/bin
	install -m 0755 $(BINARY) $(PREFIX)/bin/patchgraph
