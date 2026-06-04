import { useState } from 'react'
import './App.css'

type FileNode = {
  kind: 'file'
  name: string
  path: string
}

type DirectoryNode = {
  kind: 'directory'
  name: string
  path: string
  children: TreeNode[]
}

type TreeNode = FileNode | DirectoryNode

type Stats = {
  directories: number
  files: number
}

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.yarn',
])

async function buildTree(
  handle: FileSystemDirectoryHandle,
  parentPath = '',
): Promise<{ tree: TreeNode[]; stats: Stats }> {
  const entries: TreeNode[] = []
  let directories = 0
  let files = 0

  for await (const entry of handle.values()) {
    const path = parentPath ? `${parentPath}/${entry.name}` : entry.name

    if (entry.kind === 'directory') {
      const directoryEntry = entry as FileSystemDirectoryHandle

      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue
      }

      const child = await buildTree(directoryEntry, path)

      entries.push({
        kind: 'directory',
        name: entry.name,
        path,
        children: child.tree,
      })

      directories += 1 + child.stats.directories
      files += child.stats.files
      continue
    }

    entries.push({
      kind: 'file',
      name: entry.name,
      path,
    })

    files += 1
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }

    return left.name.localeCompare(right.name)
  })

  return {
    tree: entries,
    stats: { directories, files },
  }
}

function TreeBranch({
  nodes,
  selectedPath,
  onSelect,
}: {
  nodes: TreeNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  return (
    <ul className="tree-list">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.kind === 'directory' ? (
            <details open className="tree-directory">
              <summary>{node.name}</summary>
              {node.children.length > 0 ? (
                <TreeBranch
                  nodes={node.children}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                />
              ) : (
                <div className="tree-empty">Empty directory</div>
              )}
            </details>
          ) : (
            <button
              type="button"
              className={
                selectedPath === node.path ? 'tree-file tree-file-active' : 'tree-file'
              }
              onClick={() => onSelect(node.path)}
            >
              {node.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function App() {
  const [repoName, setRepoName] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [status, setStatus] = useState<string>(
    'Select a local repository directory to inspect its files in the browser.',
  )
  const [isLoading, setIsLoading] = useState(false)

  const openDirectory = async () => {
    if (!('showDirectoryPicker' in window)) {
      setStatus('This browser does not support directory picking. Use a recent Chromium-based browser.')
      return
    }

    try {
      setIsLoading(true)
      setStatus('Scanning directory...')

      const handle = await window.showDirectoryPicker({
        mode: 'read',
      })

      const result = await buildTree(handle)

      setRepoName(handle.name)
      setTree(result.tree)
      setStats(result.stats)
      setSelectedPath(null)
      setStatus(`Loaded ${result.stats.files} files across ${result.stats.directories} folders.`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus('Directory selection cancelled.')
      } else {
        setStatus('Failed to read the selected directory.')
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">PatchGraph</p>
          <h1>Open a local repo and inspect its file tree.</h1>
          <p className="hero-text">
            This first slice stays browser-native: pick a directory, scan it client-side,
            and render a project explorer without needing a backend yet.
          </p>
        </div>

        <div className="hero-actions">
          <button type="button" className="primary-button" onClick={openDirectory} disabled={isLoading}>
            {isLoading ? 'Scanning…' : 'Open repository'}
          </button>
          <p className="status-line">{status}</p>
        </div>
      </section>

      <section className="workspace-panel">
        <header className="panel-header">
          <div>
            <p className="panel-label">Explorer</p>
            <h2>{repoName ?? 'No repository selected'}</h2>
          </div>
          {stats ? (
            <div className="stats-grid" aria-label="Repository stats">
              <div>
                <span>Files</span>
                <strong>{stats.files}</strong>
              </div>
              <div>
                <span>Folders</span>
                <strong>{stats.directories}</strong>
              </div>
            </div>
          ) : null}
        </header>

        <div className="workspace-grid">
          <div className="explorer-card">
            {tree.length > 0 ? (
              <TreeBranch
                nodes={tree}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
              />
            ) : (
              <div className="empty-state">
                Choose a repository folder to populate the explorer.
              </div>
            )}
          </div>

          <aside className="selection-card">
            <p className="panel-label">Selection</p>
            <h3>{selectedPath ?? 'Nothing selected yet'}</h3>
            <p>
              The next step can use this selected path to open file content in a review
              window or seed the future canvas view.
            </p>
          </aside>
        </div>
      </section>
    </main>
  )
}

export default App
