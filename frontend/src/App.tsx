import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './App.css'
import { CodeView, type DiffLineMeta } from './CodeView'
import { FuzzyFileSearch, TextSearch } from './SearchPalette'
import { GitMenu } from './GitMenu'
import { hasLspInfo, parseLspAnalysis, type LspSymbol } from './lsp'
import { ConnectionsOverlay } from './Connections'
import {
	findSnapAnchor,
	type Connection,
	type ConnectionDraft,
	type DotAnchor,
} from './connectionGeometry'

function anchorKey(anchor: { kind: string; windowID: string; line?: number; character?: number }) {
	return anchor.kind === 'dot'
		? `d:${anchor.windowID}:${anchor.line}:${anchor.character}`
		: `w:${anchor.windowID}`
}

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
	title?: string
	subtitle?: string
	state: LoadState
	error: string
	lines: string[]
	diffLines: DiffLineMeta[] | null
	lspState: LspState
	symbols: LspSymbol[]
	// Zero-based line to scroll to and highlight when the window opens (set when
	// the window was opened by clicking an LSP location).
	focusLine: number | null
	// When set, the window shows only this inclusive line span instead of the
	// whole file — used to open a definition as just its own lines.
	visibleRange: { start: number; end: number } | null
	width: number | null
	height: number | null
	x: number
	y: number
	zIndex: number
}

type BranchComparison = {
	base: string
	compare: string
	files: BranchFileDiff[]
}

type BranchFileDiff = {
	filename: string
	oldPath?: string
	status: 'added' | 'deleted' | 'modified' | 'renamed'
	hunkIndex: number
	header: string
	lines: BranchDiffLine[]
}

type BranchDiffLine = {
	kind: 'context' | 'added' | 'removed' | 'collapsed'
	oldLine?: number
	newLine?: number
	text: string
	changes?: DiffLineChange[]
	hidden?: BranchHiddenDiffLine[]
}

type BranchHiddenDiffLine = {
	kind: 'context'
	oldLine?: number
	newLine?: number
	text: string
	changes?: DiffLineChange[]
}

type DiffLineChange = {
	start: number
	end: number
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

function isBranchComparison(value: unknown): value is BranchComparison {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.base === 'string' &&
		typeof candidate.compare === 'string' &&
		Array.isArray(candidate.files) &&
		candidate.files.every(isBranchFileDiff)
	)
}

function isBranchFileDiff(value: unknown): value is BranchFileDiff {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.filename === 'string' &&
		(candidate.oldPath === undefined || typeof candidate.oldPath === 'string') &&
		(candidate.status === 'added' ||
			candidate.status === 'deleted' ||
			candidate.status === 'modified' ||
			candidate.status === 'renamed') &&
		typeof candidate.hunkIndex === 'number' &&
		typeof candidate.header === 'string' &&
		Array.isArray(candidate.lines) &&
		candidate.lines.every(isBranchDiffLine)
	)
}

function isBranchDiffLine(value: unknown): value is BranchDiffLine {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const candidate = value as Record<string, unknown>
	return (
		(candidate.kind === 'context' ||
			candidate.kind === 'added' ||
			candidate.kind === 'removed' ||
			candidate.kind === 'collapsed') &&
		(candidate.oldLine === undefined || typeof candidate.oldLine === 'number') &&
		(candidate.newLine === undefined || typeof candidate.newLine === 'number') &&
		typeof candidate.text === 'string' &&
		(candidate.changes === undefined ||
			(Array.isArray(candidate.changes) && candidate.changes.every(isDiffLineChange))) &&
		(candidate.hidden === undefined ||
			(Array.isArray(candidate.hidden) && candidate.hidden.every(isBranchHiddenDiffLine)))
	)
}

function isBranchHiddenDiffLine(value: unknown): value is BranchHiddenDiffLine {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const candidate = value as Record<string, unknown>
	return (
		candidate.kind === 'context' &&
		(candidate.oldLine === undefined || typeof candidate.oldLine === 'number') &&
		(candidate.newLine === undefined || typeof candidate.newLine === 'number') &&
		typeof candidate.text === 'string' &&
		(candidate.changes === undefined ||
			(Array.isArray(candidate.changes) && candidate.changes.every(isDiffLineChange)))
	)
}

function isDiffLineChange(value: unknown): value is DiffLineChange {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.start === 'number' &&
		typeof candidate.end === 'number' &&
		candidate.start >= 0 &&
		candidate.end >= candidate.start
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
	offsetX,
	offsetY,
	zoom,
	openFiles,
	activeWindowID,
	viewport,
	onNavigate,
}: {
	canvasWidth: number
	canvasHeight: number
	offsetX: number
	offsetY: number
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
								left: `${(fileWindow.x + offsetX) * scale}px`,
								top: `${(fileWindow.y + offsetY) * scale}px`,
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
	// Which overlay is open over the canvas, if any: fuzzy file finder, global
	// text search, or the git branch menu. null when none is shown.
	const [searchMode, setSearchMode] = useState<'file' | 'text' | 'git' | null>(null)
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
	// Connector lines between symbol bubble dots and windows.
	const [connections, setConnections] = useState<Connection[]>([])
	// The connector currently being dragged from a dot, if any.
	const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null)
	// The selected connector (deletable via Backspace/Delete).
	const [selectedConnection, setSelectedConnection] = useState<string | null>(null)
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
	// Live mirror of the canvas origin offset (PAN_MARGIN grown by however far the
	// top-left-most window sits into negative space). The imperative drag handlers
	// read these to map pointer positions to logical window coordinates, and the
	// scroll-compensation layout effect keeps them in sync with each render.
	const offsetXRef = useRef(PAN_MARGIN)
	const offsetYRef = useRef(PAN_MARGIN)
	// Scroll offset to apply after a zoom change so the canvas point under the
	// cursor stays put (zoom-to-cursor). Consumed in a layout effect.
	const pendingScrollRef = useRef<{ left: number; top: number } | null>(null)
	// Per-window code-scroller top positions (as a fraction of scroll height)
	// captured before a zoom change and restored after, so the visible top line
	// of each open file stays put while zooming. Consumed in a layout effect.
	const codeScrollRestoreRef = useRef<{ element: Element; fraction: number }[]>([])
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

	// Global search shortcuts, available once a repo is open: Ctrl/Cmd+P opens the
	// fuzzy file finder, Ctrl/Cmd+Shift+F opens the global text search. Both are
	// no-ops without an active project.
	useEffect(() => {
		if (activeProject === null) {
			return
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			const mod = event.metaKey || event.ctrlKey
			if (!mod) {
				return
			}

			if (event.shiftKey && (event.key === 'F' || event.key === 'f')) {
				event.preventDefault()
				setSearchMode('text')
			} else if (!event.shiftKey && (event.key === 'P' || event.key === 'p')) {
				event.preventDefault()
				setSearchMode('file')
			} else if (!event.shiftKey && (event.key === 'B' || event.key === 'b')) {
				event.preventDefault()
				setSearchMode('git')
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [activeProject])

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

	// While a connector is selected: Backspace/Delete removes it, Escape and any
	// click elsewhere deselect it. (Clicking a connector stops propagation, so
	// this click handler only fires for clicks off the line.)
	useEffect(() => {
		if (selectedConnection === null) {
			return
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			const tag = document.activeElement?.tagName
			if (tag === 'INPUT' || tag === 'TEXTAREA') {
				return
			}
			if (event.key === 'Backspace' || event.key === 'Delete') {
				event.preventDefault()
				setConnections((current) => current.filter((connection) => connection.id !== selectedConnection))
				setSelectedConnection(null)
			} else if (event.key === 'Escape') {
				setSelectedConnection(null)
			}
		}
		const handleClick = () => setSelectedConnection(null)

		window.addEventListener('keydown', handleKeyDown)
		window.addEventListener('click', handleClick)
		return () => {
			window.removeEventListener('keydown', handleKeyDown)
			window.removeEventListener('click', handleClick)
		}
	}, [selectedConnection])

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

			// Capture each open file's vertical scroll as a fraction of its total
			// height (scale-invariant), so we can restore the same top line after the
			// zoom re-lays-out the (CSS zoom) scaled scroll containers.
			codeScrollRestoreRef.current = Array.from(
				workspace.querySelectorAll('.file-code-scroll'),
			).map((element) => ({
				element,
				fraction: element.scrollHeight > 0 ? element.scrollTop / element.scrollHeight : 0,
			}))

			zoomRef.current = nextZoom
			setZoom(nextZoom)
		}

		workspace.addEventListener('wheel', handleWheel, { passive: false })
		return () => workspace.removeEventListener('wheel', handleWheel)
	}, [])

	// Apply the zoom-to-cursor scroll correction once the new scale has been laid
	// out, before paint, to avoid a visible jump.
	useLayoutEffect(() => {
		// Restore each open file's top line: the same scroll fraction maps to the
		// same top line at any scale, so zooming keeps the text view in place.
		for (const { element, fraction } of codeScrollRestoreRef.current) {
			element.scrollTop = fraction * element.scrollHeight
		}
		codeScrollRestoreRef.current = []

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

	// Re-fetch the active project's file list after a git action changed the
	// working tree (checkout/merge). Open windows, zoom, and expanded folders are
	// left untouched so the canvas stays put; only the explorer tree refreshes.
	async function reloadActiveProject() {
		if (activeProject === null) {
			return
		}

		try {
			const response = await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}`)
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
			setProjectState('ready')
		} catch (error) {
			setProjectError(error instanceof Error ? error.message : 'Unknown error')
			setProjectState('error')
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
			diffLines: null,
			lspState: 'loading' as LspState,
			symbols: [],
			focusLine: null,
			visibleRange: null,
			width,
			height,
			x,
			y,
			zIndex: nextZIndexRef.current++,
		}
	}

	function createDiffWindow(fileDiff: BranchFileDiff, base: string, compare: string, index: number) {
		const visibleLineCount = fileDiff.lines.length
		const pendingWindow = {
			...createWindow(fileDiff.filename),
			state: 'ready' as LoadState,
			lines: fileDiff.lines.map((line) => line.text),
			diffLines: fileDiff.lines.map(toDiffLineMeta),
			title: fileDiff.filename,
			subtitle: base + ' -> ' + compare + ' · ' + fileDiff.status + ' · ' + fileDiff.header,
			lspState: fileDiff.status === 'deleted' ? ('unsupported' as LspState) : ('loading' as LspState),
		}
		const column = index % 2
		const row = Math.floor(index / 2)
		const diffHeight = Math.min(4000, Math.max(220, 104 + visibleLineCount * 24))

		return {
			...pendingWindow,
			height: diffHeight,
			x: WINDOW_BASE_X + column * ((pendingWindow.width ?? DEFAULT_WINDOW_WIDTH) + WINDOW_OFFSET_X),
			y: WINDOW_BASE_Y + row * (diffHeight + WINDOW_OFFSET_Y),
		}
	}

	function toDiffLineMeta(line: BranchDiffLine): DiffLineMeta {
		return {
			kind: line.kind,
			oldLine: line.oldLine,
			newLine: line.newLine,
			changes: line.changes,
			hidden: line.hidden?.map((hiddenLine) => ({
				text: hiddenLine.text,
				kind: hiddenLine.kind,
				oldLine: hiddenLine.oldLine,
				newLine: hiddenLine.newLine,
				changes: hiddenLine.changes,
			})),
		}
	}

	function expandCollapsedDiff(windowID: string, lineIndex: number, direction: 'up' | 'down') {
		setOpenFiles((current) =>
			current.map((fileWindow) => {
				if (fileWindow.id !== windowID || fileWindow.diffLines === null) {
					return fileWindow
				}

				const collapsed = fileWindow.diffLines[lineIndex]
				if (collapsed?.kind !== 'collapsed' || !collapsed.hidden || collapsed.hidden.length === 0) {
					return fileWindow
				}

				const revealed =
					direction === 'down' ? collapsed.hidden.slice(0, 10) : collapsed.hidden.slice(-10)
				const remaining =
					direction === 'down' ? collapsed.hidden.slice(10) : collapsed.hidden.slice(0, -10)
				const revealedLines = revealed.map((line) => line.text)
				const revealedMeta = revealed.map((line) => ({
					kind: line.kind,
					oldLine: line.oldLine,
					newLine: line.newLine,
					changes: line.changes,
				}))
				const collapsedLineText = `${remaining.length} unchanged ${remaining.length === 1 ? 'line' : 'lines'}`
				const replacementLines =
					remaining.length > 0 && direction === 'down'
						? [...revealedLines, collapsedLineText]
						: remaining.length > 0
							? [collapsedLineText, ...revealedLines]
							: revealedLines
				const replacementMeta =
					remaining.length > 0 && direction === 'down'
						? [
								...revealedMeta,
								{
									...collapsed,
									hidden: remaining,
								},
							]
						: remaining.length > 0
							? [
									{
										...collapsed,
										hidden: remaining,
									},
									...revealedMeta,
								]
							: revealedMeta

				return {
					...fileWindow,
					lines: [
						...fileWindow.lines.slice(0, lineIndex),
						...replacementLines,
						...fileWindow.lines.slice(lineIndex + 1),
					],
					diffLines: [
						...fileWindow.diffLines.slice(0, lineIndex),
						...replacementMeta,
						...fileWindow.diffLines.slice(lineIndex + 1),
					],
					height: Math.min(4000, (fileWindow.height ?? DEFAULT_WINDOW_HEIGHT) + revealed.length * 24),
				}
			}),
		)
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

	async function openBranchComparison(base: string, compare: string) {
		if (activeProject === null) {
			return
		}

		const response = await fetch('/api/projects/' + encodeURIComponent(activeProject.id) + '/branch-diff', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ base, compare }),
		})
		if (!response.ok) {
			throw new Error('Request failed with status ' + response.status)
		}

		const data: unknown = await response.json()
		if (!isBranchComparison(data)) {
			throw new Error('Branch comparison response was invalid')
		}

		const nextWindows = data.files.map((fileDiff, index) =>
			createDiffWindow(fileDiff, data.base, data.compare, index),
		)
		setOpenFiles(nextWindows)
		setActiveWindowID(nextWindows[0]?.id ?? null)
		setOpenBubble(null)
		setConnections([])
		setSelectedConnection(null)

		for (const fileWindow of nextWindows) {
			if (fileWindow.lspState === 'loading') {
				void loadLspInfo(activeProject.id, fileWindow.filename, fileWindow.id)
			}
		}
	}

	// Opens a file in a new window scrolled to and highlighting a line, used by
	// the global text search results. `line` is 1-based (as returned by the search
	// endpoint); focusLine is zero-based.
	function openFileAtLine(filename: string, line: number) {
		if (activeProject === null) {
			return
		}

		const pendingWindow = {
			...createWindow(filename),
			focusLine: Math.max(0, line - 1),
		}
		setOpenFiles((current) => [...current, pendingWindow])
		setActiveWindowID(pendingWindow.id)

		void loadFileContents(activeProject.id, filename, pendingWindow.id)
		void loadLspInfo(activeProject.id, filename, pendingWindow.id)
	}

	// Opens the file referenced by an LSP location in a new window beside the
	// source window, scrolled to and highlighting the target line.
	function openLocationInNewWindow(
		originWindowID: string,
		path: string,
		line: number,
		source?: { line: number; character: number },
		visibleRange?: { start: number; end: number } | null,
	) {
		if (activeProject === null) {
			return
		}

		const origin = openFiles.find((fileWindow) => fileWindow.id === originWindowID) ?? null

		// In the branch diff view each file is shown in a single window. Rather than
		// opening duplicate windows, focus the existing one if the target file is
		// already open. The regular view keeps cascading new windows.
		const inDiffView = origin?.diffLines != null
		if (inDiffView) {
			const existing = openFiles.find(
				(fileWindow) => fileWindow.id !== originWindowID && fileWindow.filename === path,
			)
			if (existing) {
				focusFileWindow(existing.id)
				if (source) {
					const connectionSource: DotAnchor = {
						kind: 'dot',
						windowID: originWindowID,
						line: source.line,
						character: source.character,
					}
					addConnection(connectionSource, { kind: 'window', windowID: existing.id })
				}
				return
			}
		}

		// Highlight the definition's first line (cropped views render it at the top)
		// or, for an un-cropped open, the opened line.
		const pendingWindow = {
			...createWindow(path, origin),
			focusLine: visibleRange ? visibleRange.start : line,
			visibleRange: visibleRange ?? null,
		}
		setOpenFiles((current) => [...current, pendingWindow])
		setActiveWindowID(pendingWindow.id)

		// Draw a connector from the clicked symbol's bubble dot to the new window.
		if (source) {
			const connectionSource: DotAnchor = {
				kind: 'dot',
				windowID: originWindowID,
				line: source.line,
				character: source.character,
			}
			addConnection(connectionSource, { kind: 'window', windowID: pendingWindow.id })
		}

		void loadFileContents(activeProject.id, path, pendingWindow.id)
		void loadLspInfo(activeProject.id, path, pendingWindow.id)
	}

	function addConnection(source: Connection['source'], target: Connection['target']) {
		const id = `${anchorKey(source)}->${anchorKey(target)}`
		setConnections((current) =>
			current.some((connection) => connection.id === id)
				? current
				: [...current, { id, source, target }],
		)
	}

	const removeConnection = (id: string) =>
		setConnections((current) => current.filter((connection) => connection.id !== id))

	// Begin dragging a new connector from a symbol's bubble dot. Tracks the
	// pointer, previews snapping to the nearest dot/window, and on release either
	// commits the connector (when snapped) or discards it (when free).
	function startConnectionDraw(source: DotAnchor, clientX: number, clientY: number) {
		setSelectedConnection(null)
		const start = { x: clientX, y: clientY }
		setConnectionDraft({ source, pointer: start, snap: findSnapAnchor(start, source) })

		const handleMove = (event: PointerEvent) => {
			const pointer = { x: event.clientX, y: event.clientY }
			setConnectionDraft({ source, pointer, snap: findSnapAnchor(pointer, source) })
		}
		const handleUp = (event: PointerEvent) => {
			window.removeEventListener('pointermove', handleMove)
			window.removeEventListener('pointerup', handleUp)
			const snap = findSnapAnchor({ x: event.clientX, y: event.clientY }, source)
			if (snap) {
				addConnection(source, snap)
			}
			setConnectionDraft(null)
		}

		window.addEventListener('pointermove', handleMove)
		window.addEventListener('pointerup', handleUp)
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
		// Low enough to shrink the code area down to roughly a single visible line
		// (the header is ~85px; this leaves room for about one row beneath it).
		const minHeight = 140
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
			grabOffsetX: pointerCanvasX - moving.x - offsetXRef.current,
			grabOffsetY: pointerCanvasY - moving.y - offsetYRef.current,
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
		// No clamp: a window can be dragged arbitrarily far in any direction. When it
		// crosses the current top/left edge the canvas origin grows to fit it (see the
		// scroll-compensation effect), so the position stays valid. Subtracting the
		// live origin offset maps the rendered pointer position back to logical
		// window coordinates; pairing it with the live scrollLeft keeps the result
		// invariant across the origin shift, so the window stays glued to the pointer.
		const nextX = pointerCanvasX - drag.grabOffsetX - offsetXRef.current
		const nextY = pointerCanvasY - drag.grabOffsetY - offsetYRef.current
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

	// Bounding box of every window, then pad with PAN_MARGIN on all four sides so
	// there is always pannable empty space around the cluster. Unlike a fixed
	// origin, the left/top edge tracks the most negative window (floored at 0 so a
	// normal cluster keeps the usual PAN_MARGIN of left/top space). This lets a
	// window be dragged outward in any direction forever — the canvas just grows to
	// fit, and `offsetX/offsetY` shift the whole cluster to keep it on-canvas.
	const minX = openFiles.reduce((min, fileWindow) => Math.min(min, fileWindow.x), 0)
	const minY = openFiles.reduce((min, fileWindow) => Math.min(min, fileWindow.y), 0)
	const maxX = openFiles.reduce(
		(max, fileWindow) => Math.max(max, fileWindow.x + (fileWindow.width ?? DEFAULT_WINDOW_WIDTH)),
		0,
	)
	const maxY = openFiles.reduce(
		(max, fileWindow) => Math.max(max, fileWindow.y + (fileWindow.height ?? DEFAULT_WINDOW_HEIGHT)),
		0,
	)
	const offsetX = PAN_MARGIN - minX
	const offsetY = PAN_MARGIN - minY
	const canvasWidth = maxX - minX + PAN_MARGIN * 2
	const canvasHeight = maxY - minY + PAN_MARGIN * 2

	// When the origin shifts (a window crossed the current top/left edge, growing
	// the canvas), every window's render offset changes by the same delta. Bump the
	// scroll position by that delta so nothing appears to jump and the window under
	// the pointer stays glued to it. Runs before paint to avoid a visible flash.
	useLayoutEffect(() => {
		const workspace = workspaceRef.current
		if (workspace !== null) {
			const dx = offsetX - offsetXRef.current
			const dy = offsetY - offsetYRef.current
			if (dx !== 0) {
				workspace.scrollLeft += dx * zoomRef.current
			}
			if (dy !== 0) {
				workspace.scrollTop += dy * zoomRef.current
			}
		}
		offsetXRef.current = offsetX
		offsetYRef.current = offsetY
	}, [offsetX, offsetY])

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

							{activeProject !== null ? (
								<div className="explorer-search-actions">
									<button
										type="button"
										className="explorer-search-button"
										onClick={() => setSearchMode('file')}
										title="Find file (Ctrl/Cmd+P)"
									>
										<span className="explorer-search-icon" aria-hidden="true">⌕</span>
										Find file
									</button>
									<button
										type="button"
										className="explorer-search-button"
										onClick={() => setSearchMode('text')}
										title="Search in files (Ctrl/Cmd+Shift+F)"
									>
										<span className="explorer-search-icon" aria-hidden="true">⌕</span>
										Search text
									</button>
									<button
										type="button"
										className="explorer-search-button"
										onClick={() => setSearchMode('git')}
										title="Git branches (Ctrl/Cmd+B)"
									>
										<span className="explorer-search-icon" aria-hidden="true">⎇</span>
										Git
									</button>
								</div>
							) : null}

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
								data-window-id={fileWindow.id}
								aria-label={`File viewer for ${fileWindow.filename}`}
								style={{
									width: (fileWindow.width ?? DEFAULT_WINDOW_WIDTH) + 'px',
									height: (fileWindow.height ?? DEFAULT_WINDOW_HEIGHT) + 'px',
									transform: `translate(${fileWindow.x + offsetX}px, ${fileWindow.y + offsetY}px)`,
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
													<h2>{fileWindow.title ?? fileWindow.filename}</h2>
												</div>
												<div className="file-window-meta">
													<p>{fileWindow.subtitle ?? fileWindow.lines.length + ' lines'}</p>
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
												diffLines={fileWindow.diffLines}
												symbols={fileWindow.symbols}
												focusLine={fileWindow.focusLine}
												visibleRange={fileWindow.visibleRange}
												windowID={fileWindow.id}
												openBubble={openBubble}
												onBubbleChange={setOpenBubble}
												onOpenLocation={(path, line, source, visibleRange) =>
													openLocationInNewWindow(fileWindow.id, path, line, source, visibleRange)
												}
												onStartConnection={startConnectionDraw}
												onExpandCollapsedDiff={(lineIndex, direction) =>
													expandCollapsedDiff(fileWindow.id, lineIndex, direction)
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

					<ConnectionsOverlay
						connections={connections}
						draft={connectionDraft}
						selectedID={selectedConnection}
						onSelect={setSelectedConnection}
						onRemove={removeConnection}
						width={canvasWidth}
						height={canvasHeight}
						zoomRef={zoomRef}
					/>
				</div>
			</main>

			{activeProject !== null ? (
				<Minimap
					canvasWidth={canvasWidth}
					canvasHeight={canvasHeight}
					offsetX={offsetX}
					offsetY={offsetY}
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

			{searchMode === 'file' && activeProject !== null ? (
				<FuzzyFileSearch
					files={activeProject.files}
					onOpen={(filename) => handleFileOpen(filename)}
					onClose={() => setSearchMode(null)}
				/>
			) : null}

			{searchMode === 'text' && activeProject !== null ? (
				<TextSearch
					projectID={activeProject.id}
					onOpen={(filename, line) => openFileAtLine(filename, line)}
					onClose={() => setSearchMode(null)}
				/>
			) : null}

			{searchMode === 'git' && activeProject !== null ? (
			<GitMenu
				projectID={activeProject.id}
				onClose={() => setSearchMode(null)}
				onWorkingTreeChanged={() => void reloadActiveProject()}
				onCompare={(base, compare) =>
					openBranchComparison(base, compare)
						.then(() => setSearchMode(null))
						.catch((error) => {
							setProjectState('error')
							setProjectError(error instanceof Error ? error.message : 'Unknown error')
						})
				}
			/>
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
