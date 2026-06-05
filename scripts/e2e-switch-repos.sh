#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)

for tool in docker git curl python3; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "missing required tool: $tool" >&2
		exit 1
	fi
done

temp_home=$(mktemp -d)
projects_root="$temp_home/projects"
main_repo="$projects_root/PatchGraph"
worktree_repo="$projects_root/_worktrees/PatchGraph-worktree"
compose_project="patchgraph-e2e-$RANDOM-$$"
backend_port=${PATCHGRAPH_E2E_PORT:-18080}

compose() {
	HOME="$temp_home" PORT="$backend_port" COMPOSE_PROJECT_NAME="$compose_project" \
		docker compose -f "$repo_root/docker-compose.yml" "$@"
}

cleanup() {
	compose down -v --remove-orphans >/dev/null 2>&1 || true
	rm -rf "$temp_home"
}
trap cleanup EXIT

mkdir -p "$projects_root" "$(dirname "$worktree_repo")"

git init -q "$main_repo"
git -C "$main_repo" config user.name "PatchGraph E2E"
git -C "$main_repo" config user.email "patchgraph-e2e@example.com"
printf 'base\n' >"$main_repo/base.txt"
git -C "$main_repo" add base.txt
git -C "$main_repo" commit -qm "base"
git -C "$main_repo" branch feature/worktree-switch
git -C "$main_repo" worktree add "$worktree_repo" feature/worktree-switch >/dev/null
printf 'worktree\n' >"$worktree_repo/worktree.txt"

if ! compose up -d --build backend >/dev/null 2>&1; then
	compose logs backend >&2 || true
	exit 1
fi

for _ in $(seq 1 30); do
	if curl -fsS "http://127.0.0.1:$backend_port/api/projects" >/tmp/patchgraph-e2e-projects.json; then
		break
	fi
	sleep 1
done

if [ ! -f /tmp/patchgraph-e2e-projects.json ]; then
	compose logs backend >&2 || true
	echo "backend did not become ready" >&2
	exit 1
fi

python3 - <<'PY' "$backend_port"
import json
import sys
import urllib.request

port = sys.argv[1]
with open("/tmp/patchgraph-e2e-projects.json", "r", encoding="utf-8") as handle:
    projects = json.load(handle)

if len(projects) != 2:
    raise SystemExit(f"expected 2 projects, got {len(projects)}: {projects}")

projects_by_path = {project["path"]: project for project in projects}
for expected in ("PatchGraph", "_worktrees/PatchGraph-worktree"):
    if expected not in projects_by_path:
        raise SystemExit(f"missing expected project path {expected!r}: {projects}")

checks = {
    "PatchGraph": "base.txt",
    "_worktrees/PatchGraph-worktree": "worktree.txt",
}

for path, expected_file in checks.items():
    project = projects_by_path[path]
    with urllib.request.urlopen(
        f"http://127.0.0.1:{port}/api/projects/{project['id']}/files"
    ) as response:
        files = json.load(response)
    if expected_file not in files:
        raise SystemExit(f"{path} missing {expected_file!r}: {files}")

print("repo switch e2e passed")
PY
