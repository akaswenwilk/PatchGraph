# PatchGraph

PatchGraph is a local-first web app for reviewing code changes with semantic
context.

## Build

```bash
make build
```

This builds the frontend, embeds it into the Go backend, and writes the
production binary to `build/patchgraph`.

## Install

```bash
make install
```

The default install location is `~/.local/bin/patchgraph`. Override it with
`PREFIX`:

```bash
make install PREFIX=/usr/local
```

## Run Locally

```bash
patchgraph start
```

The app serves the frontend and backend API from the same port. It listens on
`8080` by default and scans `~/projects` by default.

```bash
patchgraph start --port 9090 --projects ~/projects
```

`PORT`, `PATCHGRAPH_PROJECTS_ROOT`, and `PATCHGRAPH_CONFIG` are also supported.
When `--config` and `PATCHGRAPH_CONFIG` are omitted, PatchGraph uses
`~/.config/patchgraph/config.yaml` if it exists.

## Language Server Config

PatchGraph accepts YAML configuration for language-server commands,
initialization options, and workspace settings:

```bash
patchgraph start --config ~/.config/patchgraph/config.yaml
```

For example, to pass Go build tags to `gopls`:

```yaml
languageServers:
  go:
    settings:
      gopls:
        buildFlags:
          - -tags=integration,e2e
```

You can also override the server command:

```yaml
languageServers:
  go:
    command:
      - gopls
      - serve
      - -rpc.trace
```

For backend-only development:

```bash
cd backend
go run ./cmd/server start
```

For frontend development, Vite proxies `/api` to the backend:

```bash
cd frontend
npm install
npm run dev
```

## Run with Docker Compose

```bash
docker compose up --build
```

## Run E2E Tests

```bash
cd frontend
npm run test:e2e
```

That command runs a dedicated Docker Compose stack that seeds test repos, starts the backend and frontend, and executes Playwright inside a containerized browser runtime.
