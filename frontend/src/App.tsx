import { useEffect, useState } from 'react'
import './App.css'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

function MenuIcon() {
  return (
    <span className="menu-icon" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

function getFuzzyScore(projectName: string, query: string) {
	const candidate = projectName.toLowerCase()
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

function filterProjects(projects: string[], query: string) {
	if (query.trim() === '') {
		return [...projects].sort((left, right) => left.localeCompare(right))
	}

	return projects
		.map((projectName) => ({
			projectName,
			score: getFuzzyScore(projectName, query),
		}))
		.filter((entry) => Number.isFinite(entry.score))
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score
			}

			return left.projectName.localeCompare(right.projectName)
		})
		.map((entry) => entry.projectName)
}

function App() {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [projects, setProjects] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const filteredProjects = filterProjects(projects, query)
  const activeProject =
    selectedProject !== null && filteredProjects.includes(selectedProject)
      ? selectedProject
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
    setSelectedProject(null)
    setLoadState('loading')
    setErrorMessage('')

    try {
      const response = await fetch('/api/projects')
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`)
      }

      const data: unknown = await response.json()
      if (!Array.isArray(data) || data.some((entry) => typeof entry !== 'string')) {
        throw new Error('Projects response was not a string array')
      }

      const nextProjects = [...new Set(data)].sort((left, right) => left.localeCompare(right))
      setProjects(nextProjects)
      setSelectedProject(nextProjects[0] ?? null)
      setLoadState('ready')
    } catch (error) {
      setProjects([])
      setSelectedProject(null)
      setLoadState('error')
      setErrorMessage(error instanceof Error ? error.message : 'Unknown error')
    }
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

      <main className="workspace" aria-hidden="true" />

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
              {loadState === 'loading' ? <p className="project-status">Loading projects…</p> : null}
              {loadState === 'error' ? (
                <p className="project-status project-status-error">
                  Could not load projects. {errorMessage}
                </p>
              ) : null}
              {loadState === 'ready' && filteredProjects.length === 0 ? (
                <p className="project-status">No matching repos.</p>
              ) : null}
              {loadState === 'ready' && filteredProjects.length > 0 ? (
                <div className="project-list" role="listbox" aria-label="Projects">
                  {filteredProjects.map((projectName) => {
                    const isSelected = projectName === activeProject

                    return (
                      <button
                        key={projectName}
                        type="button"
                        className={isSelected ? 'project-row project-row-selected' : 'project-row'}
                        aria-selected={isSelected}
                        onClick={() => setSelectedProject(projectName)}
                      >
                        {projectName}
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
                onClick={() => {}}
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
