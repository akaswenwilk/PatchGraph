# PatchGraph

PatchGraph is organized as a small monorepo:

- `frontend/` contains the web UI
- `backend/` contains the Go API

## Run

    docker compose up --build

The backend runs on `http://localhost:8080` and reads projects from your host `~/projects` directory through the compose bind mount at `/projects`.
