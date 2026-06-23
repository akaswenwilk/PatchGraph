import { useEffect, useMemo, useRef, useState } from 'react'

// Subsequence fuzzy score: every needle character must appear in order in the
// candidate. Consecutive matches (streaks) are rewarded so contiguous hits rank
// above scattered ones, and shorter candidates are preferred. Returns
// NEGATIVE_INFINITY when the needle is not a subsequence. Mirrors the project
// picker's scorer in App.tsx so both searches feel the same.
function fuzzyScore(candidate: string, needle: string): number {
	const haystack = candidate.toLowerCase()
	const query = needle.trim().toLowerCase()

	if (query === '') {
		return 0
	}

	let score = 0
	let queryIndex = 0
	let streak = 0

	for (let index = 0; index < haystack.length; index += 1) {
		if (haystack[index] !== query[queryIndex]) {
			streak = 0
			continue
		}

		score += 1 + streak * 2
		queryIndex += 1
		streak += 1

		if (queryIndex === query.length) {
			return score - (haystack.length - query.length)
		}
	}

	return Number.NEGATIVE_INFINITY
}

const MAX_FILE_RESULTS = 100

// A fixed, front-of-everything command palette for fuzzy-matching a file path
// from the open project and opening it in a new window. Arrow keys move the
// selection, Enter opens it, Escape closes.
export function FuzzyFileSearch({
	files,
	onOpen,
	onClose,
}: {
	files: string[]
	onOpen: (filename: string) => void
	onClose: () => void
}) {
	const [query, setQuery] = useState('')
	const [activeIndex, setActiveIndex] = useState(0)
	const listRef = useRef<HTMLDivElement | null>(null)

	const results = useMemo(() => {
		const trimmed = query.trim()
		if (trimmed === '') {
			return files.slice(0, MAX_FILE_RESULTS)
		}

		return files
			.map((file) => ({ file, score: fuzzyScore(file, trimmed) }))
			.filter((entry) => Number.isFinite(entry.score))
			.sort((left, right) => {
				if (right.score !== left.score) {
					return right.score - left.score
				}
				return left.file.localeCompare(right.file)
			})
			.slice(0, MAX_FILE_RESULTS)
			.map((entry) => entry.file)
	}, [files, query])

	// Keep the highlighted row scrolled into view as the selection moves.
	useEffect(() => {
		const list = listRef.current
		if (list === null) {
			return
		}
		const active = list.querySelector('[data-active="true"]')
		if (active instanceof HTMLElement) {
			active.scrollIntoView({ block: 'nearest' })
		}
	}, [activeIndex, results])

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === 'ArrowDown') {
			event.preventDefault()
			setActiveIndex((index) => Math.min(index + 1, results.length - 1))
		} else if (event.key === 'ArrowUp') {
			event.preventDefault()
			setActiveIndex((index) => Math.max(index - 1, 0))
		} else if (event.key === 'Enter') {
			event.preventDefault()
			const selected = results[activeIndex]
			if (selected !== undefined) {
				onOpen(selected)
				onClose()
			}
		}
	}

	return (
		<SearchOverlay title="Find file" subtitle="Fuzzy-match a file to open it." onClose={onClose}>
			<label className="project-search-field">
				<span>Search files</span>
				<input
					type="text"
					value={query}
					onChange={(event) => {
						setQuery(event.target.value)
						setActiveIndex(0)
					}}
					onKeyDown={handleKeyDown}
					placeholder="Start typing a file name"
					autoFocus
				/>
			</label>

			<div className="project-results-panel" ref={listRef}>
				{results.length === 0 ? (
					<p className="project-status">No matching files.</p>
				) : (
					<div className="project-list" role="listbox" aria-label="Files">
						{results.map((file, index) => {
							const isActive = index === activeIndex
							const slash = file.lastIndexOf('/')
							const name = slash === -1 ? file : file.slice(slash + 1)
							const dir = slash === -1 ? '' : file.slice(0, slash)

							return (
								<button
									key={file}
									type="button"
									className={isActive ? 'project-row project-row-selected' : 'project-row'}
									data-active={isActive}
									aria-selected={isActive}
									onPointerMove={() => setActiveIndex(index)}
									onClick={() => {
										onOpen(file)
										onClose()
									}}
								>
									<span className="project-row-name">{name}</span>
									{dir !== '' ? <span className="project-row-path">{dir}</span> : null}
								</button>
							)
						})}
					</div>
				)}
			</div>
		</SearchOverlay>
	)
}

type SearchMatch = {
	filename: string
	line: number
	text: string
}

function isSearchMatch(value: unknown): value is SearchMatch {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.filename === 'string' &&
		typeof candidate.line === 'number' &&
		typeof candidate.text === 'string'
	)
}

type SearchState = 'idle' | 'loading' | 'ready' | 'error'

const SEARCH_DEBOUNCE_MS = 200

// A fixed, front-of-everything palette for a global text search across the open
// project. Typing debounces a request to the backend; each result shows the file,
// line number, and the matching line. Clicking a result opens the file in a new
// window scrolled to that line.
export function TextSearch({
	projectID,
	onOpen,
	onClose,
}: {
	projectID: string
	onOpen: (filename: string, line: number) => void
	onClose: () => void
}) {
	const [query, setQuery] = useState('')
	const [matches, setMatches] = useState<SearchMatch[]>([])
	const [state, setState] = useState<SearchState>('idle')
	const [error, setError] = useState('')

	useEffect(() => {
		const trimmed = query.trim()
		// The empty-query reset happens in the input handler, so an empty query
		// here is simply a no-op (avoids a synchronous setState in the effect body).
		if (trimmed === '') {
			return
		}

		let cancelled = false
		const controller = new AbortController()

		const timer = window.setTimeout(async () => {
			setState('loading')
			try {
				const response = await fetch(`/api/projects/${encodeURIComponent(projectID)}/search`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ query: trimmed }),
					signal: controller.signal,
				})
				if (!response.ok) {
					throw new Error(`Request failed with status ${response.status}`)
				}

				const data: unknown = await response.json()
				if (!Array.isArray(data) || data.some((entry) => !isSearchMatch(entry))) {
					throw new Error('Search response was invalid')
				}

				if (!cancelled) {
					setMatches(data)
					setState('ready')
				}
			} catch (caught) {
				if (cancelled || controller.signal.aborted) {
					return
				}
				setMatches([])
				setState('error')
				setError(caught instanceof Error ? caught.message : 'Unknown error')
			}
		}, SEARCH_DEBOUNCE_MS)

		return () => {
			cancelled = true
			controller.abort()
			window.clearTimeout(timer)
		}
	}, [projectID, query])

	return (
		<SearchOverlay
			title="Search in files"
			subtitle="Find text across the open project."
			onClose={onClose}
		>
			<label className="project-search-field">
				<span>Search text</span>
				<input
					type="text"
					value={query}
					onChange={(event) => {
						const next = event.target.value
						setQuery(next)
						if (next.trim() === '') {
							setMatches([])
							setState('idle')
							setError('')
						}
					}}
					placeholder="Start typing to search file contents"
					autoFocus
				/>
			</label>

			<div className="project-results-panel">
				{state === 'loading' ? <p className="project-status">Searching…</p> : null}
				{state === 'error' ? (
					<p className="project-status project-status-error">Search failed. {error}</p>
				) : null}
				{state === 'ready' && matches.length === 0 ? (
					<p className="project-status">No matches.</p>
				) : null}
				{matches.length > 0 ? (
					<div className="search-result-list" role="listbox" aria-label="Search results">
						{matches.map((match, index) => (
							<button
								key={`${match.filename}:${match.line}:${index}`}
								type="button"
								className="search-result-row"
								onClick={() => {
									onOpen(match.filename, match.line)
									onClose()
								}}
							>
								<span className="search-result-head">
									<span className="search-result-file">{match.filename}</span>
									<span className="search-result-line">:{match.line}</span>
								</span>
								<code className="search-result-text">{match.text}</code>
							</button>
						))}
					</div>
				) : null}
			</div>
		</SearchOverlay>
	)
}

// Shared modal chrome for both search palettes: a blurred backdrop, an Escape /
// backdrop-click close, and the project-modal card styling reused from the repo
// picker so the palettes feel native.
export function SearchOverlay({
	title,
	subtitle,
	onClose,
	children,
}: {
	title: string
	subtitle: string
	onClose: () => void
	children: React.ReactNode
}) {
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				onClose()
			}
		}
		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [onClose])

	return (
		<div className="modal-layer" role="presentation">
			<button type="button" className="modal-backdrop" aria-label="Close search" onClick={onClose} />

			<section className="project-modal search-modal" role="dialog" aria-modal="true" aria-label={title}>
				<div className="project-modal-header">
					<div>
						<h1>{title}</h1>
						<p>{subtitle}</p>
					</div>
					<button
						type="button"
						className="modal-close-button"
						aria-label="Close search"
						onClick={onClose}
					>
						×
					</button>
				</div>

				{children}
			</section>
		</div>
	)
}
