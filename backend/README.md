# PatchGraph Backend

Minimal Go HTTP server scaffold for the PatchGraph backend.

## Run locally

    cd backend
    export PATCHGRAPH_PROJECTS_ROOT=~/projects
    go run ./cmd/server

The server listens on `PORT` when set, otherwise defaults to `8080`.
