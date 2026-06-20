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

`PORT` and `PATCHGRAPH_PROJECTS_ROOT` are also supported.

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
