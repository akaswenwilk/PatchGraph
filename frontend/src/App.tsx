import { useState } from 'react'
import './App.css'

function MenuIcon() {
  return (
    <span className="menu-icon" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

function App() {
  const [isCollapsed, setIsCollapsed] = useState(false)

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
          <button type="button" className="open-project-button">
            Open Repo
          </button>
        ) : null}
      </aside>

      <main className="workspace" aria-hidden="true" />
    </div>
  )
}

export default App
