import { useEffect, useRef, useState } from 'react'
import './App.css'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

type ProjectSummary = {
	id: string
	name: string
	path: string
}

type ProjectDetail = {
	id: string
	name: string
	path: string
	files: string[]
}

type OpenFile = {
	id: string
	filename: string
	state: LoadState
	error: string
	lines: string[]
	width: number | null
	height: number | null
	x: number
	y: number
	zIndex: number
}

type TreeNode = {
	name: string
	path: string
	kind: 'directory' | 'file'
	children: TreeNode[]
}

const DEFAULT_WINDOW_WIDTH = 900
const DEFAULT_WINDOW_HEIGHT = 640
const WINDOW_OFFSET_X = 28
const WINDOW_OFFSET_Y = 24
const WINDOW_MARGIN = 24
// Canvas coordinate of the first window: clears the fixed explorer (24px gap +
// 288px sidebar + 24px) at scroll origin so windows never open under it.
const WINDOW_BASE_X = 336
const WINDOW_BASE_Y = 24
// Extra breathing room added past the furthest window so the canvas can always
// scroll a little beyond its content, Miro-style.
const CANVAS_PADDING = 120

function isProjectSummary(value: unknown): value is ProjectSummary {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.id === 'string' &&
		typeof candidate.name === 'string' &&
		typeof candidate.path === 'string'
	)
}

function isProjectDetail(value: unknown): value is ProjectDetail {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.id === 'string' &&
		typeof candidate.name === 'string' &&
		typeof candidate.path === 'string' &&
		Array.isArray(candidate.files) &&
		candidate.files.every((entry) => typeof entry === 'string')
	)
}

function MenuIcon() {
	return (
		<span className="menu-icon" aria-hidden="true">
			<span />
			<span />
			<span />
		</span>
	)
}

function FolderIcon({ isOpen }: { isOpen: boolean }) {
	return <span className={isOpen ? 'tree-icon tree-icon-open' : 'tree-icon'}>{isOpen ? '▾' : '▸'}</span>
}

function getFuzzyScore(project: ProjectSummary, query: string) {
	const candidate = `${project.name} ${project.path}`.toLowerCase()
	const needle = query.trim().toLowerCase()

	if (needle === '') {
		return 0
	}

	let score = 0
	let queryIndex = 0
	let streak = 0

	for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex += 1) {
		if (candidate[candidateIndex] !== needle[queryIndex]) {
			streak = 0
			continue
		}

		score += 1 + streak * 2
		queryIndex += 1
		streak += 1

		if (queryIndex === needle.length) {
			return score - (candidate.length - needle.length)
		}
	}

	return Number.NEGATIVE_INFINITY
}

function filterProjects(projects: ProjectSummary[], query: string) {
	if (query.trim() === '') {
		return [...projects].sort((left, right) => {
			const nameCompare = left.name.localeCompare(right.name)
			if (nameCompare !== 0) {
				return nameCompare
			}

			return left.path.localeCompare(right.path)
		})
	}

	return projects
		.map((project) => ({
			project,
			score: getFuzzyScore(project, query),
		}))
		.filter((entry) => Number.isFinite(entry.score))
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score
			}

			const nameCompare = left.project.name.localeCompare(right.project.name)
			if (nameCompare !== 0) {
				return nameCompare
			}

			return left.project.path.localeCompare(right.project.path)
		})
		.map((entry) => entry.project)
}

function buildTree(filePaths: string[]): TreeNode {
	const root: TreeNode = {
		name: '',
		path: '',
		kind: 'directory',
		children: [],
	}

	for (const filePath of filePaths) {
		const segments = filePath.split('/').filter(Boolean)
		let current = root

		for (let index = 0; index < segments.length; index += 1) {
			const segment = segments[index]
			const nodePath = current.path === '' ? segment : `${current.path}/${segment}`
			const isFile = index === segments.length - 1
			let child = current.children.find((entry) => entry.path === nodePath)

			if (!child) {
				child = {
					name: segment,
					path: nodePath,
					kind: isFile ? 'file' : 'directory',
					children: [],
				}
				current.children.push(child)
			}

			current = child
		}
	}

	const sortNode = (node: TreeNode) => {
		node.children.sort((left, right) => {
			if (left.kind !== right.kind) {
				return left.kind === 'directory' ? -1 : 1
			}

			return left.name.localeCompare(right.name)
		})

		for (const child of node.children) {
			sortNode(child)
		}
	}

	sortNode(root)
	return root
}

function TreeBranch({
	node,
	depth,
	expandedPaths,
	activeFilename,
	onToggle,
	onFileOpen,
}: {
	node: TreeNode
	depth: number
	expandedPaths: Set<string>
	activeFilename: string | null
	onToggle: (path: string) => void
	onFileOpen: (path: string) => void
}) {
	if (node.kind === 'file') {
		const isSelected = node.path === activeFilename

		return (
			<li className="tree-item">
				<button
					type="button"
					className={isSelected ? 'tree-row tree-file tree-file-selected' : 'tree-row tree-file'}
					style={{ paddingLeft: `${depth * 18 + 14}px` }}
					onClick={() => onFileOpen(node.path)}
				>
					<span className="tree-file-bullet" aria-hidden="true">
						•
					</span>
					<span className="tree-label">{node.name}</span>
				</button>
			</li>
		)
	}

	const isOpen = expandedPaths.has(node.path)

	return (
		<li className="tree-item">
			<button
				type="button"
				className="tree-row tree-directory"
				style={{ paddingLeft: `${depth * 18 + 10}px` }}
				onClick={() => onToggle(node.path)}
			>
				<FolderIcon isOpen={isOpen} />
				<span className="tree-label">{node.name}</span>
			</button>
			{isOpen && node.children.length > 0 ? (
				<ul className="tree-list">
					{node.children.map((child) => (
						<TreeBranch
							key={child.path}
							node={child}
							depth={depth + 1}
							expandedPaths={expandedPaths}
							activeFilename={activeFilename}
							onToggle={onToggle}
							onFileOpen={onFileOpen}
						/>
					))}
				</ul>
			) : null}
		</li>
	)
}

function App() {
	const [isCollapsed, setIsCollapsed] = useState(false)
	const [isModalOpen, setIsModalOpen] = useState(false)
	const [projects, setProjects] = useState<ProjectSummary[]>([])
	const [query, setQuery] = useState('')
	const [selectedProjectID, setSelectedProjectID] = useState<string | null>(null)
	const [projectPickerState, setProjectPickerState] = useState<LoadState>('idle')
	const [projectPickerError, setProjectPickerError] = useState('')
	const [projectState, setProjectState] = useState<LoadState>('idle')
	const [projectError, setProjectError] = useState('')
	const [activeProject, setActiveProject] = useState<ProjectDetail | null>(null)
	const [fileTree, setFileTree] = useState<TreeNode | null>(null)
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
	const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
	const [activeWindowID, setActiveWindowID] = useState<string | null>(null)
	const nextWindowIDRef = useRef(1)
	const nextZIndexRef = useRef(1)
	const dragStateRef = useRef<{
		windowID: string
		pointerID: number
		startClientX: number
		startClientY: number
		startX: number
		startY: number
		previousUserSelect: string
		previousCursor: string
	} | null>(null)
	const activeFilename =
		activeWindowID === null
			? null
			: (openFiles.find((fileWindow) => fileWindow.id === activeWindowID)?.filename ?? null)

	const filteredProjects = filterProjects(projects, query)
	const highlightedProject =
		selectedProjectID !== null
			? filteredProjects.find((project) => project.id === selectedProjectID) ?? (filteredProjects[0] ?? null)
			: (filteredProjects[0] ?? null)

	useEffect(() => {
		if (!isModalOpen) {
			return
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setIsModalOpen(false)
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [isModalOpen])

	async function openProjectPicker() {
		setIsModalOpen(true)
		setQuery('')
		setSelectedProjectID(null)
		setProjectPickerState('loading')
		setProjectPickerError('')

		try {
			const response = await fetch('/api/projects')
			if (!response.ok) {
				throw new Error(`Request failed with status ${response.status}`)
			}

			const data: unknown = await response.json()
			if (!Array.isArray(data) || data.some((entry) => !isProjectSummary(entry))) {
				throw new Error('Projects response was not a valid project list')
			}

			const nextProjects = [...data].sort((left, right) => {
				const nameCompare = left.name.localeCompare(right.name)
				if (nameCompare !== 0) {
					return nameCompare
				}

				return left.path.localeCompare(right.path)
			})
			setProjects(nextProjects)
			setSelectedProjectID(nextProjects[0]?.id ?? null)
			setProjectPickerState('ready')
		} catch (error) {
			setProjects([])
			setSelectedProjectID(null)
			setProjectPickerState('error')
			setProjectPickerError(error instanceof Error ? error.message : 'Unknown error')
		}
	}

	async function handleProjectOpen() {
		if (highlightedProject === null) {
			return
		}

		setProjectState('loading')
		setProjectError('')
		setOpenFiles([])
		setActiveWindowID(null)

		try {
			const response = await fetch(`/api/projects/${encodeURIComponent(highlightedProject.id)}`)
			if (!response.ok) {
				throw new Error(`Request failed with status ${response.status}`)
			}

			const data: unknown = await response.json()
			if (!isProjectDetail(data)) {
				throw new Error('Project response was invalid')
			}

			const project = {
				...data,
				files: [...data.files].sort((left, right) => left.localeCompare(right)),
			}
			setActiveProject(project)
			setFileTree(buildTree(project.files))
			setExpandedPaths(new Set([project.id]))
			setProjectState('ready')
			setIsModalOpen(false)
		} catch (error) {
			setActiveProject(null)
			setFileTree(null)
			setExpandedPaths(new Set())
			setProjectState('error')
			setProjectError(error instanceof Error ? error.message : 'Unknown error')
		}
	}

	function createWindow(filename: string) {
		const topWindow = openFiles.reduce<OpenFile | null>(
			(currentTop, candidate) =>
				currentTop === null || candidate.zIndex > currentTop.zIndex ? candidate : currentTop,
			null,
		)
		const maxWidth = Math.max(320, window.innerWidth - 384 - WINDOW_MARGIN)
		const maxHeight = Math.max(280, window.innerHeight - WINDOW_MARGIN * 2)
		const width = Math.min(DEFAULT_WINDOW_WIDTH, maxWidth)
		const height = Math.min(DEFAULT_WINDOW_HEIGHT, maxHeight)
		// On the infinite canvas we only cascade from the previous top window; the
		// canvas grows to fit, so positions are never clamped to the viewport.
		const x =
			topWindow === null ? WINDOW_BASE_X : Math.max(0, topWindow.x + WINDOW_OFFSET_X)
		const y =
			topWindow === null ? WINDOW_BASE_Y : Math.max(0, topWindow.y + WINDOW_OFFSET_Y)

		return {
			id: String(nextWindowIDRef.current++),
			filename,
			state: 'loading' as LoadState,
			error: '',
			lines: [],
			width,
			height,
			x,
			y,
			zIndex: nextZIndexRef.current++,
		}
	}

	async function handleFileOpen(filename: string) {
		if (activeProject === null) {
			return
		}

		const pendingWindow = createWindow(filename)
		setOpenFiles((current) => [...current, pendingWindow])
		setActiveWindowID(pendingWindow.id)

		try {
			const response = await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}/files`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ filename }),
			})
			if (!response.ok) {
				throw new Error(`Request failed with status ${response.status}`)
			}

			const data: unknown = await response.json()
			if (!Array.isArray(data) || data.some((entry) => typeof entry !== 'string')) {
				throw new Error('File response was not a string array')
			}

			setOpenFiles((current) =>
				current.map((fileWindow) =>
					fileWindow.id === pendingWindow.id
						? {
								...fileWindow,
								state: 'ready',
								error: '',
								lines: data,
							}
						: fileWindow,
				),
			)
		} catch (error) {
			setOpenFiles((current) =>
				current.map((fileWindow) =>
					fileWindow.id === pendingWindow.id
						? {
								...fileWindow,
								state: 'error',
								error: error instanceof Error ? error.message : 'Unknown error',
								lines: [],
							}
						: fileWindow,
				),
			)
		}
	}

	function focusFileWindow(windowID: string) {
		setOpenFiles((current) =>
			current.map((fileWindow) => {
				if (fileWindow.id !== windowID) {
					return fileWindow
				}

				return {
					...fileWindow,
					zIndex: nextZIndexRef.current++,
				}
			}),
		)
		setActiveWindowID(windowID)
	}

	function closeFileWindow(windowID: string) {
		const remaining = openFiles.filter((fileWindow) => fileWindow.id !== windowID)
		const nextActiveWindow = remaining.reduce<OpenFile | null>(
			(currentTop, candidate) =>
				currentTop === null || candidate.zIndex > currentTop.zIndex ? candidate : currentTop,
			null,
		)
		setOpenFiles(remaining)
		setActiveWindowID(nextActiveWindow?.id ?? null)
	}

	function startViewerResize(
		windowID: string,
		direction: 'horizontal' | 'vertical' | 'both',
		event: React.PointerEvent<HTMLButtonElement>,
	) {
		event.preventDefault()
		event.stopPropagation()

		focusFileWindow(windowID)
		const fileWindow = event.currentTarget.closest('.file-window')
		if (fileWindow === null) {
			return
		}

		event.currentTarget.setPointerCapture(event.pointerId)

		const rect = fileWindow.getBoundingClientRect()
		const minWidth = 320
		const minHeight = 280
		// The canvas is scrollable, so windows may grow well past the viewport.
		const maxWidth = 4000
		const maxHeight = 4000
		const previousUserSelect = document.body.style.userSelect
		const previousCursor = document.body.style.cursor
		document.body.style.userSelect = 'none'
		document.body.style.cursor =
			direction === 'horizontal'
				? 'ew-resize'
				: direction === 'vertical'
					? 'ns-resize'
					: 'nwse-resize'

		const handlePointerMove = (event: PointerEvent) => {
			setOpenFiles((current) =>
				current.map((fileWindow) => {
					if (fileWindow.id !== windowID) {
						return fileWindow
					}

					const currentWidth = fileWindow.width ?? rect.width
					const currentHeight = fileWindow.height ?? rect.height
					const nextWidth =
						direction === 'vertical'
							? currentWidth
							: Math.min(maxWidth, Math.max(minWidth, event.clientX - rect.left))
					const nextHeight =
						direction === 'horizontal'
							? currentHeight
							: Math.min(maxHeight, Math.max(minHeight, event.clientY - rect.top))

					return {
						...fileWindow,
						width: nextWidth,
						height: nextHeight,
					}
				}),
			)
		}

		const handlePointerUp = () => {
			window.removeEventListener('pointermove', handlePointerMove)
			window.removeEventListener('pointerup', handlePointerUp)
			document.body.style.userSelect = previousUserSelect
			document.body.style.cursor = previousCursor
		}

		window.addEventListener('pointermove', handlePointerMove)
		window.addEventListener('pointerup', handlePointerUp)
	}

	function startWindowDrag(windowID: string, event: React.PointerEvent<HTMLElement>) {
		// Let the close button keep its own click; don't hijack it into a drag.
		if ((event.target as HTMLElement).closest('.file-window-close-button')) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		focusFileWindow(windowID)

		const moving = openFiles.find((fileWindow) => fileWindow.id === windowID)
		if (moving === undefined) {
			return
		}

		// Capture the pointer on the header so every move is delivered here for the
		// whole gesture, even after the pointer leaves the header element.
		event.currentTarget.setPointerCapture(event.pointerId)
		dragStateRef.current = {
			windowID,
			pointerID: event.pointerId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startX: moving.x,
			startY: moving.y,
			previousUserSelect: document.body.style.userSelect,
			previousCursor: document.body.style.cursor,
		}
		document.body.style.userSelect = 'none'
		document.body.style.cursor = 'grabbing'
	}

	function handleWindowDragMove(event: React.PointerEvent<HTMLElement>) {
		const drag = dragStateRef.current
		if (drag === null || event.pointerId !== drag.pointerID) {
			return
		}

		const nextX = Math.max(0, drag.startX + (event.clientX - drag.startClientX))
		const nextY = Math.max(0, drag.startY + (event.clientY - drag.startClientY))
		setOpenFiles((current) =>
			current.map((fileWindow) =>
				fileWindow.id === drag.windowID ? { ...fileWindow, x: nextX, y: nextY } : fileWindow,
			),
		)
	}

	function endWindowDrag(event: React.PointerEvent<HTMLElement>) {
		const drag = dragStateRef.current
		if (drag === null || event.pointerId !== drag.pointerID) {
			return
		}

		document.body.style.userSelect = drag.previousUserSelect
		document.body.style.cursor = drag.previousCursor
		dragStateRef.current = null
	}

	function togglePath(path: string) {
		setExpandedPaths((current) => {
			const next = new Set(current)
			if (next.has(path)) {
				next.delete(path)
			} else {
				next.add(path)
			}
			return next
		})
	}

	const canvasWidth =
		openFiles.reduce(
			(max, fileWindow) => Math.max(max, fileWindow.x + (fileWindow.width ?? DEFAULT_WINDOW_WIDTH)),
			0,
		) + CANVAS_PADDING
	const canvasHeight =
		openFiles.reduce(
			(max, fileWindow) => Math.max(max, fileWindow.y + (fileWindow.height ?? DEFAULT_WINDOW_HEIGHT)),
			0,
		) + CANVAS_PADDING

	return (
		<div className="app-shell">
			<aside
				className={isCollapsed ? 'sidebar sidebar-collapsed' : 'sidebar'}
				aria-label="Sidebar"
			>
				<button
					type="button"
					className="menu-button"
					aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
					aria-pressed={!isCollapsed}
					onClick={() => setIsCollapsed((value) => !value)}
				>
					<MenuIcon />
				</button>

				{!isCollapsed ? (
					<>
						<div className="sidebar-content">
							<div className="explorer-panel-header">
								<div>
									<p className="explorer-eyebrow">Explorer</p>
									<h1>{activeProject?.name ?? 'No repo opened'}</h1>
									<p className="explorer-subtitle">
										{activeProject?.path ?? 'Choose a repo to load its file tree.'}
									</p>
								</div>
							</div>

							<div className="explorer-tree-panel">
								{projectState === 'idle' ? (
									<p className="project-status">Open a repo to load files.</p>
								) : null}
								{projectState === 'loading' ? (
									<p className="project-status">Loading files…</p>
								) : null}
								{projectState === 'error' ? (
									<p className="project-status project-status-error">
										Could not load files. {projectError}
									</p>
								) : null}
								{projectState === 'ready' && activeProject !== null && fileTree !== null ? (
									<ul className="tree-list">
										<TreeBranch
											node={{
												name: activeProject.name,
												path: activeProject.id,
												kind: 'directory',
								children: fileTree.children,
							}}
							depth={0}
							expandedPaths={expandedPaths}
							activeFilename={activeFilename}
							onToggle={togglePath}
							onFileOpen={(path) => void handleFileOpen(path)}
						/>
					</ul>
				) : null}
			</div>
		</div>

						<button type="button" className="open-project-button" onClick={openProjectPicker}>
							{activeProject === null ? 'Open Repo' : 'Switch Repo'}
						</button>
					</>
				) : null}
			</aside>

			<main className="workspace">
				<div
					className="workspace-canvas"
					style={{ width: canvasWidth + 'px', height: canvasHeight + 'px' }}
				>
				{[...openFiles]
					.sort((left, right) => left.zIndex - right.zIndex)
					.map((fileWindow) => {
						const isActive = fileWindow.id === activeWindowID
						return (
							<section
								key={fileWindow.id}
								className={isActive ? 'file-window file-window-active' : 'file-window'}
								aria-label={`File viewer for ${fileWindow.filename}`}
								style={{
									width: (fileWindow.width ?? DEFAULT_WINDOW_WIDTH) + 'px',
									height: (fileWindow.height ?? DEFAULT_WINDOW_HEIGHT) + 'px',
									transform: `translate(${fileWindow.x}px, ${fileWindow.y}px)`,
									zIndex: fileWindow.zIndex,
								}}
								onPointerDown={() => focusFileWindow(fileWindow.id)}
							>
								{fileWindow.state === 'loading' ? (
									<div className="workspace-placeholder">
										<p className="workspace-eyebrow">Opening file</p>
										<h2>{fileWindow.filename}</h2>
										<p>Loading file contents…</p>
									</div>
								) : fileWindow.state === 'error' ? (
									<div className="workspace-placeholder workspace-placeholder-error">
										<p className="workspace-eyebrow">File error</p>
										<h2>{fileWindow.filename}</h2>
										<p>{fileWindow.error}</p>
									</div>
								) : (
									<>
										<header
											className="file-window-header"
											onPointerDown={(event) => startWindowDrag(fileWindow.id, event)}
											onPointerMove={handleWindowDragMove}
											onPointerUp={endWindowDrag}
											onPointerCancel={endWindowDrag}
										>
											<div className="file-window-title-group">
												<div>
													<p className="workspace-eyebrow">{activeProject?.name ?? ''}</p>
													<h2>{fileWindow.filename}</h2>
												</div>
												<p>{fileWindow.lines.length} lines</p>
											</div>

											<button
												type="button"
												className="file-window-close-button"
												aria-label={`Close ${fileWindow.filename}`}
												onClick={() => closeFileWindow(fileWindow.id)}
											>
												×
											</button>
										</header>

										<div className="file-code-scroll">
											<div className="file-code" role="presentation">
												{fileWindow.lines.map((line, index) => (
													<div className="code-row" key={`${fileWindow.id}:${index + 1}`}>
														<span className="line-number">{index + 1}</span>
														<span className="line-content">{line === '' ? ' ' : line}</span>
													</div>
												))}
											</div>
										</div>
									</>
								)}

								<button
									type="button"
									className="file-window-resize-handle file-window-resize-handle-right"
									aria-label={`Resize ${fileWindow.filename} width`}
									onPointerDown={(event) => startViewerResize(fileWindow.id, 'horizontal', event)}
								/>
								<button
									type="button"
									className="file-window-resize-handle file-window-resize-handle-bottom"
									aria-label={`Resize ${fileWindow.filename} height`}
									onPointerDown={(event) => startViewerResize(fileWindow.id, 'vertical', event)}
								/>
								<button
									type="button"
									className="file-window-resize-handle file-window-resize-handle-corner"
									aria-label={`Resize ${fileWindow.filename}`}
									onPointerDown={(event) => startViewerResize(fileWindow.id, 'both', event)}
								/>
							</section>
						)
					})}
				</div>
			</main>

			{isModalOpen ? (
				<div className="modal-layer" role="presentation">
					<button
						type="button"
						className="modal-backdrop"
						aria-label="Close project picker"
						onClick={() => setIsModalOpen(false)}
					/>

					<section
						className="project-modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="project-modal-title"
					>
						<div className="project-modal-header">
							<div>
								<h1 id="project-modal-title">Open Repo</h1>
								<p>Choose a project from the backend index.</p>
							</div>

							<button
								type="button"
								className="modal-close-button"
								aria-label="Close project picker"
								onClick={() => setIsModalOpen(false)}
							>
								×
							</button>
						</div>

						<label className="project-search-field">
							<span>Search repos</span>
							<input
								type="text"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Start typing a repo name"
								autoFocus
							/>
						</label>

						<div className="project-results-panel">
							{projectPickerState === 'loading' ? (
								<p className="project-status">Loading projects…</p>
							) : null}
							{projectPickerState === 'error' ? (
								<p className="project-status project-status-error">
									Could not load projects. {projectPickerError}
								</p>
							) : null}
							{projectPickerState === 'ready' && filteredProjects.length === 0 ? (
								<p className="project-status">No matching repos.</p>
							) : null}
							{projectPickerState === 'ready' && filteredProjects.length > 0 ? (
								<div className="project-list" role="listbox" aria-label="Projects">
									{filteredProjects.map((project) => {
										const isSelected = project.id === highlightedProject?.id

										return (
											<button
												key={project.id}
												type="button"
												className={
													isSelected ? 'project-row project-row-selected' : 'project-row'
												}
												aria-selected={isSelected}
												onClick={() => setSelectedProjectID(project.id)}
												onDoubleClick={() => void handleProjectOpen()}
											>
												<span className="project-row-name">{project.name}</span>
												<span className="project-row-path">{project.path}</span>
											</button>
										)
									})}
								</div>
							) : null}
						</div>

						<div className="project-modal-actions">
							<button
								type="button"
								className="secondary-button"
								onClick={() => setIsModalOpen(false)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="primary-button"
								disabled={highlightedProject === null}
								onClick={() => void handleProjectOpen()}
							>
								Open
							</button>
						</div>
					</section>
				</div>
			) : null}
		</div>
	)
}

export default App
