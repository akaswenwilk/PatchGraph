import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './App.css'
import { CodeView } from './CodeView'
import { hasLspInfo, parseLspAnalysis, type LspSymbol } from './lsp'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

// LSP analysis is optional: 'unsupported' means the file's language has no
// configured language server, so no bubbles are shown and it is not an error.
type LspState = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error'

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
	lspState: LspState
	symbols: LspSymbol[]
	// Zero-based line to scroll to and highlight when the window opens (set when
	// the window was opened by clicking an LSP location).
	focusLine: number | null
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
// Empty space kept on every side of the window cluster so the canvas can always
// be panned around, Miro-style, even with a single window or a couple of windows
// sitting side by side. The canvas is sized to content + this margin on all four
// sides, and windows render offset by it so there is room above/left of them too.
const PAN_MARGIN = 2000
// Ctrl+wheel zoom of the canvas (windows + their text). The file explorer lives
// outside the canvas, so it is never scaled.
const MIN_ZOOM = 0.25
const MAX_ZOOM = 3
// Per-wheel-notch sensitivity; multiplied into an exponential so zooming feels
// uniform at every scale.
const ZOOM_WHEEL_SENSITIVITY = 0.0015
// Fixed-size overview map pinned at the top-right. The whole logical canvas is
// scaled to fit inside this box (aspect preserved), windows are drawn as little
// rectangles, and the current viewport is outlined; clicking/dragging in it pans
// the real view. Like the Miro minimap / Xcode storyboard overview.
const MINIMAP_MAX_WIDTH = 220
const MINIMAP_MAX_HEIGHT = 160

function clampZoom(value: number) {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

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

function Minimap({
	canvasWidth,
	canvasHeight,
	zoom,
	openFiles,
	activeWindowID,
	viewport,
	onNavigate,
}: {
	canvasWidth: number
	canvasHeight: number
	zoom: number
	openFiles: OpenFile[]
	activeWindowID: string | null
	viewport: { scrollLeft: number; scrollTop: number; width: number; height: number }
	onNavigate: (logicalX: number, logicalY: number) => void
}) {
	const mapRef = useRef<HTMLDivElement | null>(null)
	const isDraggingRef = useRef(false)

	// Single scale that fits the whole canvas inside the box with aspect intact.
	const scale = Math.min(MINIMAP_MAX_WIDTH / canvasWidth, MINIMAP_MAX_HEIGHT / canvasHeight)
	const mapWidth = canvasWidth * scale
	const mapHeight = canvasHeight * scale

	// The visible viewport, expressed in logical canvas units (scrollLeft is in
	// scaled screen px, so divide by zoom), then scaled into the minimap.
	const viewLeft = (viewport.scrollLeft / zoom) * scale
	const viewTop = (viewport.scrollTop / zoom) * scale
	const viewWidth = (viewport.width / zoom) * scale
	const viewHeight = (viewport.height / zoom) * scale

	const navigateFromEvent = (clientX: number, clientY: number) => {
		const node = mapRef.current
		if (node === null) {
			return
		}

		const rect = node.getBoundingClientRect()
		const localX = clientX - rect.left
		const localY = clientY - rect.top
		// Map back from minimap px to logical canvas coords; App centers the view.
		onNavigate(localX / scale, localY / scale)
	}

	const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault()
		isDraggingRef.current = true
		event.currentTarget.setPointerCapture(event.pointerId)
		navigateFromEvent(event.clientX, event.clientY)
	}

	const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		if (!isDraggingRef.current) {
			return
		}
		navigateFromEvent(event.clientX, event.clientY)
	}

	const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
		isDraggingRef.current = false
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}
	}

	return (
		<div className="minimap" aria-hidden="true">
			<div
				ref={mapRef}
				className="minimap-canvas"
				style={{ width: `${mapWidth}px`, height: `${mapHeight}px` }}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
			>
				{openFiles.map((fileWindow) => {
					const basename =
						fileWindow.filename.split('/').pop() ?? fileWindow.filename
					return (
						<div
							key={fileWindow.id}
							className={
								fileWindow.id === activeWindowID
									? 'minimap-window minimap-window-active'
									: 'minimap-window'
							}
							style={{
								left: `${(fileWindow.x + PAN_MARGIN) * scale}px`,
								top: `${(fileWindow.y + PAN_MARGIN) * scale}px`,
								width: `${(fileWindow.width ?? DEFAULT_WINDOW_WIDTH) * scale}px`,
								height: `${(fileWindow.height ?? DEFAULT_WINDOW_HEIGHT) * scale}px`,
							}}
						>
							<span className="minimap-window-label" title={fileWindow.filename}>
								{basename}
							</span>
						</div>
					)
				})}

				<div
					className="minimap-viewport"
					style={{
						left: `${viewLeft}px`,
						top: `${viewTop}px`,
						width: `${viewWidth}px`,
						height: `${viewHeight}px`,
					}}
				/>
			</div>
		</div>
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
	// Id of the single LSP popover currently open across all windows, so opening
	// one bubble closes any other. null when none is open.
	const [openBubble, setOpenBubble] = useState<string | null>(null)
	const [zoom, setZoom] = useState(1)
	const [isHelpOpen, setIsHelpOpen] = useState(false)
	// Live viewport (scroll offset + visible size) of the scroll container, kept in
	// state so the minimap can redraw the "where am I" rectangle as the user scrolls,
	// zooms, or resizes the window.
	const [viewport, setViewport] = useState({ scrollLeft: 0, scrollTop: 0, width: 0, height: 0 })
	const nextWindowIDRef = useRef(1)
	const nextZIndexRef = useRef(1)
	const workspaceRef = useRef<HTMLElement | null>(null)
	// Mirror of `zoom` for the imperative pointer/wheel handlers, which run
	// outside React's render and must read the live scale.
	const zoomRef = useRef(1)
	// Scroll offset to apply after a zoom change so the canvas point under the
	// cursor stays put (zoom-to-cursor). Consumed in a layout effect.
	const pendingScrollRef = useRef<{ left: number; top: number } | null>(null)
	const dragStateRef = useRef<{
		windowID: string
		pointerID: number
		// Offset (in canvas coordinates) between the pointer and the window origin
		// at grab time, so the window tracks the pointer regardless of scroll.
		grabOffsetX: number
		grabOffsetY: number
		// Last known pointer position (viewport coords), reused by the auto-scroll
		// loop to keep moving the window while the pointer is held near an edge.
		lastClientX: number
		lastClientY: number
		autoScrollFrame: number | null
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

	// Dismiss the help popover on Escape or a click outside it.
	useEffect(() => {
		if (!isHelpOpen) {
			return
		}

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as HTMLElement
			if (target.closest('.explorer-help') === null) {
				setIsHelpOpen(false)
			}
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setIsHelpOpen(false)
			}
		}

		window.addEventListener('pointerdown', handlePointerDown)
		window.addEventListener('keydown', handleKeyDown)
		return () => {
			window.removeEventListener('pointerdown', handlePointerDown)
			window.removeEventListener('keydown', handleKeyDown)
		}
	}, [isHelpOpen])

	// Close the open LSP popover on Escape.
	useEffect(() => {
		if (openBubble === null) {
			return
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setOpenBubble(null)
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [openBubble])

	// Ctrl+wheel zooms the canvas. We attach natively with passive:false because
	// React's synthetic wheel listener is passive — preventDefault there can't
	// stop the browser's own page zoom.
	useEffect(() => {
		const workspace = workspaceRef.current
		if (workspace === null) {
			return
		}

		const handleWheel = (event: WheelEvent) => {
			if (!event.ctrlKey) {
				return
			}

			event.preventDefault()

			const oldZoom = zoomRef.current
			const nextZoom = clampZoom(oldZoom * Math.exp(-event.deltaY * ZOOM_WHEEL_SENSITIVITY))
			if (nextZoom === oldZoom) {
				return
			}

			// Keep the canvas point currently under the cursor anchored there after
			// the scale change by pre-computing the matching scroll offset.
			const rect = workspace.getBoundingClientRect()
			const offsetX = event.clientX - rect.left
			const offsetY = event.clientY - rect.top
			const canvasX = (offsetX + workspace.scrollLeft) / oldZoom
			const canvasY = (offsetY + workspace.scrollTop) / oldZoom
			pendingScrollRef.current = {
				left: canvasX * nextZoom - offsetX,
				top: canvasY * nextZoom - offsetY,
			}

			zoomRef.current = nextZoom
			setZoom(nextZoom)
		}

		workspace.addEventListener('wheel', handleWheel, { passive: false })
		return () => workspace.removeEventListener('wheel', handleWheel)
	}, [])

	// Apply the zoom-to-cursor scroll correction once the new scale has been laid
	// out, before paint, to avoid a visible jump.
	useLayoutEffect(() => {
		const workspace = workspaceRef.current
		const pending = pendingScrollRef.current
		if (workspace === null || pending === null) {
			return
		}

		workspace.scrollLeft = pending.left
		workspace.scrollTop = pending.top
		pendingScrollRef.current = null
	}, [zoom])

	// Open scrolled to the logical content origin so the empty top/left pan margin
	// starts off-screen — the view looks unchanged on load, but the user can now
	// scroll up/left into the margin (and right/down past content) to pan around
	// freely, even with a single window. Runs once on mount.
	useLayoutEffect(() => {
		const workspace = workspaceRef.current
		if (workspace === null) {
			return
		}

		workspace.scrollLeft = PAN_MARGIN
		workspace.scrollTop = PAN_MARGIN
	}, [])

	// Keep `viewport` in sync with the scroll container. Programmatic scrolls (the
	// mount origin jump, zoom-to-cursor correction, drag auto-scroll, minimap
	// navigation) all fire 'scroll', so this one listener covers every case; the
	// ResizeObserver handles window/container resizes.
	useEffect(() => {
		const workspace = workspaceRef.current
		if (workspace === null) {
			return
		}

		const sync = () => {
			setViewport({
				scrollLeft: workspace.scrollLeft,
				scrollTop: workspace.scrollTop,
				width: workspace.clientWidth,
				height: workspace.clientHeight,
			})
		}

		sync()
		workspace.addEventListener('scroll', sync, { passive: true })
		const observer = new ResizeObserver(sync)
		observer.observe(workspace)
		return () => {
			workspace.removeEventListener('scroll', sync)
			observer.disconnect()
		}
	}, [])

	// Center the view on a logical canvas point (minimap click/drag). scrollLeft is
	// in scaled screen px, so multiply the logical point by zoom, then offset by half
	// the viewport to center it; clamp to the scrollable range.
	function centerViewOn(logicalX: number, logicalY: number) {
		const workspace = workspaceRef.current
		if (workspace === null) {
			return
		}

		const targetLeft = logicalX * zoomRef.current - workspace.clientWidth / 2
		const targetTop = logicalY * zoomRef.current - workspace.clientHeight / 2
		workspace.scrollLeft = Math.max(
			0,
			Math.min(targetLeft, workspace.scrollWidth - workspace.clientWidth),
		)
		workspace.scrollTop = Math.max(
			0,
			Math.min(targetTop, workspace.scrollHeight - workspace.clientHeight),
		)
	}

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

	function createWindow(filename: string, anchor?: OpenFile | null) {
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
		// canvas grows to fit, so positions are never clamped to the viewport. When
		// opened from a location, sit directly to the right of the source window.
		let x: number
		let y: number
		if (anchor) {
			x = Math.max(0, anchor.x + (anchor.width ?? DEFAULT_WINDOW_WIDTH) + WINDOW_OFFSET_X)
			y = Math.max(0, anchor.y)
		} else if (topWindow === null) {
			x = WINDOW_BASE_X
			y = WINDOW_BASE_Y
		} else {
			x = Math.max(0, topWindow.x + WINDOW_OFFSET_X)
			y = Math.max(0, topWindow.y + WINDOW_OFFSET_Y)
		}

		return {
			id: String(nextWindowIDRef.current++),
			filename,
			state: 'loading' as LoadState,
			error: '',
			lines: [],
			lspState: 'loading' as LspState,
			symbols: [],
			focusLine: null,
			width,
			height,
			x,
			y,
			zIndex: nextZIndexRef.current++,
		}
	}

	async function loadFileContents(projectID: string, filename: string, windowID: string) {
		try {
			const response = await fetch(`/api/projects/${encodeURIComponent(projectID)}/files`, {
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
					fileWindow.id === windowID
						? { ...fileWindow, state: 'ready', error: '', lines: data }
						: fileWindow,
				),
			)
		} catch (error) {
			setOpenFiles((current) =>
				current.map((fileWindow) =>
					fileWindow.id === windowID
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

	function handleFileOpen(filename: string) {
		if (activeProject === null) {
			return
		}

		const pendingWindow = createWindow(filename)
		setOpenFiles((current) => [...current, pendingWindow])
		setActiveWindowID(pendingWindow.id)

		// Contents and language-server info load in parallel; neither blocks the other.
		void loadFileContents(activeProject.id, filename, pendingWindow.id)
		void loadLspInfo(activeProject.id, filename, pendingWindow.id)
	}

	// Opens the file referenced by an LSP location in a new window beside the
	// source window, scrolled to and highlighting the target line.
	function openLocationInNewWindow(originWindowID: string, path: string, line: number) {
		if (activeProject === null) {
			return
		}

		const origin = openFiles.find((fileWindow) => fileWindow.id === originWindowID) ?? null
		const pendingWindow = { ...createWindow(path, origin), focusLine: line }
		setOpenFiles((current) => [...current, pendingWindow])
		setActiveWindowID(pendingWindow.id)

		void loadFileContents(activeProject.id, path, pendingWindow.id)
		void loadLspInfo(activeProject.id, path, pendingWindow.id)
	}

	async function loadLspInfo(projectID: string, filename: string, windowID: string) {
		const updateWindow = (changes: Partial<OpenFile>) => {
			setOpenFiles((current) =>
				current.map((fileWindow) =>
					fileWindow.id === windowID ? { ...fileWindow, ...changes } : fileWindow,
				),
			)
		}

		try {
			const response = await fetch(`/api/projects/${encodeURIComponent(projectID)}/lsp`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ filename }),
			})

			// 400 = unsupported language (no server configured). Not an error.
			if (response.status === 400) {
				updateWindow({ lspState: 'unsupported', symbols: [] })
				return
			}
			if (!response.ok) {
				throw new Error(`Request failed with status ${response.status}`)
			}

			const data: unknown = await response.json()
			const analysis = parseLspAnalysis(data)
			if (analysis === null) {
				throw new Error('LSP response was invalid')
			}

			updateWindow({ lspState: 'ready', symbols: analysis.symbols })
		} catch {
			// Cross-references are an enhancement; on failure just show no bubbles.
			updateWindow({ lspState: 'error', symbols: [] })
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

					// rect is the on-screen (zoomed) box; convert pointer deltas back to
					// unscaled units so stored width/height stay in canvas space.
					const scale = zoomRef.current
					const currentWidth = fileWindow.width ?? rect.width / scale
					const currentHeight = fileWindow.height ?? rect.height / scale
					const nextWidth =
						direction === 'vertical'
							? currentWidth
							: Math.min(maxWidth, Math.max(minWidth, (event.clientX - rect.left) / scale))
					const nextHeight =
						direction === 'horizontal'
							? currentHeight
							: Math.min(maxHeight, Math.max(minHeight, (event.clientY - rect.top) / scale))

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

		const workspace = workspaceRef.current
		if (workspace === null) {
			return
		}

		// Convert the pointer (viewport coords) into canvas coords using the scroll
		// container's fixed rect plus its current scroll offset, then record how far
		// the grab point sits from the window origin.
		// Divide by zoom so the grab offset is in unscaled canvas units, matching
		// the coordinates we store in window.x/window.y.
		const rect = workspace.getBoundingClientRect()
		const pointerCanvasX = (event.clientX - rect.left + workspace.scrollLeft) / zoomRef.current
		const pointerCanvasY = (event.clientY - rect.top + workspace.scrollTop) / zoomRef.current

		// Capture the pointer on the header so every move is delivered here for the
		// whole gesture, even after the pointer leaves the header element.
		event.currentTarget.setPointerCapture(event.pointerId)
		dragStateRef.current = {
			windowID,
			pointerID: event.pointerId,
			grabOffsetX: pointerCanvasX - moving.x - PAN_MARGIN,
			grabOffsetY: pointerCanvasY - moving.y - PAN_MARGIN,
			lastClientX: event.clientX,
			lastClientY: event.clientY,
			autoScrollFrame: null,
			previousUserSelect: document.body.style.userSelect,
			previousCursor: document.body.style.cursor,
		}
		document.body.style.userSelect = 'none'
		document.body.style.cursor = 'grabbing'
	}

	// Reposition the dragged window from the last known pointer position and the
	// container's live scroll offset. Reading scroll live means the window stays
	// glued to the pointer even while the auto-scroll loop pans the canvas.
	function updateDraggedWindowPosition() {
		const drag = dragStateRef.current
		const workspace = workspaceRef.current
		if (drag === null || workspace === null) {
			return
		}

		const rect = workspace.getBoundingClientRect()
		const pointerCanvasX = (drag.lastClientX - rect.left + workspace.scrollLeft) / zoomRef.current
		const pointerCanvasY = (drag.lastClientY - rect.top + workspace.scrollTop) / zoomRef.current
		// Allow dragging up/left into the surrounding pan margin (down to
		// -PAN_MARGIN, where the window sits at the canvas edge), not just to the
		// content origin. The lower bound keeps it within the scrollable canvas so
		// the fixed render offset never needs to reflow mid-drag.
		const nextX = Math.max(-PAN_MARGIN, pointerCanvasX - drag.grabOffsetX - PAN_MARGIN)
		const nextY = Math.max(-PAN_MARGIN, pointerCanvasY - drag.grabOffsetY - PAN_MARGIN)
		setOpenFiles((current) =>
			current.map((fileWindow) =>
				fileWindow.id === drag.windowID ? { ...fileWindow, x: nextX, y: nextY } : fileWindow,
			),
		)
	}

	// Pixels from the container edge at which auto-scroll kicks in, and the max
	// pan speed (px/frame) once the pointer reaches the very edge.
	const AUTO_SCROLL_EDGE = 60
	const AUTO_SCROLL_MAX_SPEED = 24

	function edgeVelocity(distance: number): number {
		if (distance >= AUTO_SCROLL_EDGE) {
			return 0
		}
		// Ramp from 0 at the threshold to full speed at (and past) the edge.
		const intensity = Math.min(1, (AUTO_SCROLL_EDGE - distance) / AUTO_SCROLL_EDGE)
		return AUTO_SCROLL_MAX_SPEED * intensity
	}

	function runAutoScroll() {
		const drag = dragStateRef.current
		const workspace = workspaceRef.current
		if (drag === null || workspace === null) {
			if (drag !== null) {
				drag.autoScrollFrame = null
			}
			return
		}

		const rect = workspace.getBoundingClientRect()
		const leftDist = drag.lastClientX - rect.left
		const rightDist = rect.right - drag.lastClientX
		const topDist = drag.lastClientY - rect.top
		const bottomDist = rect.bottom - drag.lastClientY

		const dx = edgeVelocity(rightDist) - edgeVelocity(leftDist)
		const dy = edgeVelocity(bottomDist) - edgeVelocity(topDist)

		if (dx !== 0 || dy !== 0) {
			workspace.scrollLeft += dx
			workspace.scrollTop += dy
			// Pan dragged the canvas under the pointer — re-glue the window.
			updateDraggedWindowPosition()
		}

		drag.autoScrollFrame = requestAnimationFrame(runAutoScroll)
	}

	function handleWindowDragMove(event: React.PointerEvent<HTMLElement>) {
		const drag = dragStateRef.current
		if (drag === null || event.pointerId !== drag.pointerID) {
			return
		}

		drag.lastClientX = event.clientX
		drag.lastClientY = event.clientY
		updateDraggedWindowPosition()

		// Keep a single auto-scroll loop alive for the whole gesture; it no-ops
		// while the pointer is away from the edges.
		if (drag.autoScrollFrame === null) {
			drag.autoScrollFrame = requestAnimationFrame(runAutoScroll)
		}
	}

	function endWindowDrag(event: React.PointerEvent<HTMLElement>) {
		const drag = dragStateRef.current
		if (drag === null || event.pointerId !== drag.pointerID) {
			return
		}

		if (drag.autoScrollFrame !== null) {
			cancelAnimationFrame(drag.autoScrollFrame)
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

	// Content extent (furthest window edges), then pad with PAN_MARGIN on every
	// side: left/top via the per-window render offset, right/bottom via these sizes.
	const contentWidth = openFiles.reduce(
		(max, fileWindow) => Math.max(max, fileWindow.x + (fileWindow.width ?? DEFAULT_WINDOW_WIDTH)),
		0,
	)
	const contentHeight = openFiles.reduce(
		(max, fileWindow) => Math.max(max, fileWindow.y + (fileWindow.height ?? DEFAULT_WINDOW_HEIGHT)),
		0,
	)
	const canvasWidth = contentWidth + PAN_MARGIN * 2
	const canvasHeight = contentHeight + PAN_MARGIN * 2

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

								<div className="explorer-help">
									<button
										type="button"
										className="explorer-help-button"
										aria-label="Show canvas commands"
										aria-expanded={isHelpOpen}
										onClick={() => setIsHelpOpen((value) => !value)}
									>
										?
									</button>

									{isHelpOpen ? (
										<div className="explorer-help-popover" role="dialog" aria-label="Canvas commands">
											<p className="explorer-help-title">Commands</p>
											<p className="explorer-help-line">
												Hold <kbd>Ctrl</kbd> and use the scroll wheel to zoom in and out.
											</p>
										</div>
									) : null}
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

			<main className="workspace" ref={workspaceRef}>
				<div
					className="workspace-canvas"
					style={{ width: canvasWidth + 'px', height: canvasHeight + 'px', zoom }}
				>
				{/*
					Render in stable insertion order and let each window's CSS `z-index`
					(set from fileWindow.zIndex below) handle stacking. Sorting the list by
					zIndex here would reorder the DOM nodes on every focus change, which
					moves the captured header mid-gesture and breaks the active drag
					(stuck grab cursor + a leaked auto-scroll rAF loop).
				*/}
				{openFiles.map((fileWindow) => {
						const isActive = fileWindow.id === activeWindowID
						return (
							<section
								key={fileWindow.id}
								className={isActive ? 'file-window file-window-active' : 'file-window'}
								aria-label={`File viewer for ${fileWindow.filename}`}
								style={{
									width: (fileWindow.width ?? DEFAULT_WINDOW_WIDTH) + 'px',
									height: (fileWindow.height ?? DEFAULT_WINDOW_HEIGHT) + 'px',
									transform: `translate(${fileWindow.x + PAN_MARGIN}px, ${fileWindow.y + PAN_MARGIN}px)`,
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
											onLostPointerCapture={endWindowDrag}
										>
											<div className="file-window-title-group">
												<div>
													<p className="workspace-eyebrow">{activeProject?.name ?? ''}</p>
													<h2>{fileWindow.filename}</h2>
												</div>
												<div className="file-window-meta">
													<p>{fileWindow.lines.length} lines</p>
													<LspStatusChip fileWindow={fileWindow} />
												</div>
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
											<CodeView
												filename={fileWindow.filename}
												lines={fileWindow.lines}
												symbols={fileWindow.symbols}
												focusLine={fileWindow.focusLine}
												windowID={fileWindow.id}
												openBubble={openBubble}
												onBubbleChange={setOpenBubble}
												onOpenLocation={(path, line) =>
													openLocationInNewWindow(fileWindow.id, path, line)
												}
											/>
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

			{activeProject !== null ? (
				<Minimap
					canvasWidth={canvasWidth}
					canvasHeight={canvasHeight}
					zoom={zoom}
					openFiles={openFiles}
					activeWindowID={activeWindowID}
					viewport={viewport}
					onNavigate={centerViewOn}
				/>
			) : null}

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

function LspStatusChip({ fileWindow }: { fileWindow: OpenFile }) {
	switch (fileWindow.lspState) {
		case 'loading':
			return <p className="file-window-lsp file-window-lsp-loading">LSP…</p>
		case 'ready': {
			const count = fileWindow.symbols.filter(hasLspInfo).length
			return (
				<p className="file-window-lsp file-window-lsp-ready">
					LSP: {count} {count === 1 ? 'symbol' : 'symbols'}
				</p>
			)
		}
		case 'error':
			return <p className="file-window-lsp file-window-lsp-error">LSP unavailable</p>
		default:
			// 'idle' and 'unsupported' show nothing.
			return null
	}
}

export default App
