# PatchGraph Backend

Minimal Go HTTP server scaffold for the PatchGraph backend.

## Run locally

```bash
go run ./cmd/server
```

The server listens on `PORT` when set, otherwise defaults to `8080`.

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
