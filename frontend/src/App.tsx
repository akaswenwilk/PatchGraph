import { useEffect, useState } from 'react'
import './App.css'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

type ProjectSummary = {
	id: string
	name: string
	path: string
}

type TreeNode = {
	name: string
	path: string
	kind: 'directory' | 'file'
	children: TreeNode[]
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
	onToggle,
}: {
	node: TreeNode
	depth: number
	expandedPaths: Set<string>
	onToggle: (path: string) => void
}) {
	if (node.kind === 'file') {
		return (
			<li className="tree-item">
				<div className="tree-row tree-file" style={{ paddingLeft: `${depth * 18 + 14}px` }}>
					<span className="tree-file-bullet" aria-hidden="true">
						•
					</span>
					<span className="tree-label">{node.name}</span>
				</div>
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
							onToggle={onToggle}
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
	const [projectLoadState, setProjectLoadState] = useState<LoadState>('idle')
	const [projectErrorMessage, setProjectErrorMessage] = useState('')
	const [openedProject, setOpenedProject] = useState<ProjectSummary | null>(null)
	const [fileLoadState, setFileLoadState] = useState<LoadState>('idle')
	const [fileErrorMessage, setFileErrorMessage] = useState('')
	const [fileTree, setFileTree] = useState<TreeNode | null>(null)
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())

	const filteredProjects = filterProjects(projects, query)
	const activeProject =
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
		setProjectLoadState('loading')
		setProjectErrorMessage('')

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
			setProjectLoadState('ready')
		} catch (error) {
			setProjects([])
			setSelectedProjectID(null)
			setProjectLoadState('error')
			setProjectErrorMessage(error instanceof Error ? error.message : 'Unknown error')
		}
	}

	async function openSelectedProject() {
		if (activeProject === null) {
			return
		}

		setFileLoadState('loading')
		setFileErrorMessage('')

		try {
			const response = await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}/files`)
			if (!response.ok) {
				throw new Error(`Request failed with status ${response.status}`)
			}

			const data: unknown = await response.json()
			if (!Array.isArray(data) || data.some((entry) => typeof entry !== 'string')) {
				throw new Error('Files response was not a string array')
			}

			const nextFileTree = buildTree(data)
			setOpenedProject(activeProject)
			setFileTree(nextFileTree)
			setExpandedPaths(new Set())
			setFileLoadState('ready')
			setIsModalOpen(false)
		} catch (error) {
			setFileTree(null)
			setOpenedProject(activeProject)
			setFileLoadState('error')
			setFileErrorMessage(error instanceof Error ? error.message : 'Unknown error')
		}
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
					<button type="button" className="open-project-button" onClick={openProjectPicker}>
						Open Repo
					</button>
				) : null}
			</aside>

			<main className="workspace">
				<section className="explorer-panel" aria-label="File explorer">
					<div className="explorer-panel-header">
						<div>
							<p className="explorer-eyebrow">Explorer</p>
							<h1>{openedProject?.name ?? 'No repo opened'}</h1>
							<p className="explorer-subtitle">
								{openedProject?.path ?? 'Choose a repo to load its file tree.'}
							</p>
						</div>
					</div>

					<div className="explorer-tree-panel">
						{fileLoadState === 'idle' ? (
							<p className="project-status">Open a repo to load files.</p>
						) : null}
						{fileLoadState === 'loading' ? (
							<p className="project-status">Loading files…</p>
						) : null}
						{fileLoadState === 'error' ? (
							<p className="project-status project-status-error">
								Could not load files. {fileErrorMessage}
							</p>
						) : null}
						{fileLoadState === 'ready' && openedProject !== null && fileTree !== null ? (
							<ul className="tree-list">
								<TreeBranch
									node={{
										name: openedProject.name,
										path: openedProject.id,
										kind: 'directory',
										children: fileTree.children,
									}}
									depth={0}
									expandedPaths={expandedPaths}
									onToggle={togglePath}
								/>
							</ul>
						) : null}
					</div>
				</section>
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
							{projectLoadState === 'loading' ? (
								<p className="project-status">Loading projects…</p>
							) : null}
							{projectLoadState === 'error' ? (
								<p className="project-status project-status-error">
									Could not load projects. {projectErrorMessage}
								</p>
							) : null}
							{projectLoadState === 'ready' && filteredProjects.length === 0 ? (
								<p className="project-status">No matching repos.</p>
							) : null}
							{projectLoadState === 'ready' && filteredProjects.length > 0 ? (
								<div className="project-list" role="listbox" aria-label="Projects">
									{filteredProjects.map((project) => {
										const isSelected = project.id === activeProject?.id

										return (
											<button
												key={project.id}
												type="button"
												className={
													isSelected ? 'project-row project-row-selected' : 'project-row'
												}
												aria-selected={isSelected}
												onClick={() => setSelectedProjectID(project.id)}
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
								disabled={activeProject === null}
								onClick={openSelectedProject}
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
