import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(frontendDir, '..', '..')
const composeFile = path.join(repoRoot, 'docker-compose.e2e.yml')

function run(args) {
	return spawnSync('docker', args, {
		cwd: repoRoot,
		stdio: 'inherit',
	})
}

let exitCode = 1

try {
	const seed = run([
		'compose',
		'-f',
		composeFile,
		'run',
		'--build',
		'--rm',
		'init-repos',
	])
	if ((seed.status ?? 1) !== 0) {
		exitCode = seed.status ?? 1
		process.exit(exitCode)
	}

	const up = run([
		'compose',
		'-f',
		composeFile,
		'up',
		'--build',
		'--abort-on-container-exit',
		'--exit-code-from',
		'playwright',
		'backend',
		'frontend',
		'playwright',
	])
	exitCode = up.status ?? 1
} finally {
	const down = run([
		'compose',
		'-f',
		composeFile,
		'down',
		'-v',
		'--remove-orphans',
	])
	if (exitCode === 0 && (down.status ?? 1) !== 0) {
		exitCode = down.status ?? 1
	}
}

process.exit(exitCode)
