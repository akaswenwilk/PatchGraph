import { useEffect, useMemo, useState } from 'react'

import { SearchOverlay } from './SearchPalette'

type Branch = {
	name: string
	isCurrent: boolean
}

function isBranch(value: unknown): value is Branch {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const candidate = value as Record<string, unknown>
	return typeof candidate.name === 'string' && typeof candidate.isCurrent === 'boolean'
}

function parseBranches(data: unknown): Branch[] {
	if (!Array.isArray(data) || data.some((entry) => !isBranch(entry))) {
		throw new Error('Branch response was invalid')
	}
	return data
}

type BranchActionRequest =
	| { action: 'checkout'; branch: string }
	| { action: 'delete'; branch: string }
	| { action: 'create'; name: string; base: string }
	| { action: 'merge'; source: string; target: string }

// Pending interaction overlaid on the list: naming a new branch forked from
// `base`, or picking the target a `source` branch should merge into.
type PendingAction =
	| { kind: 'create'; base: string; name: string }
	| { kind: 'merge'; source: string }
	| null

type LoadState = 'loading' | 'ready' | 'error'

// The git branch menu: a modal showing the project's local branches as a flat list.
// Selecting a branch checks it out; branches can also be created off any branch,
// deleted, and merged into one another. Git failures (uncommitted changes, an
// unmerged branch, a merge conflict) surface inline with git's own message.
export function GitMenu({
	projectID,
	onClose,
	onWorkingTreeChanged,
}: {
	projectID: string
	onClose: () => void
	// Called after an action that mutates the working tree (checkout, merge) so
	// the explorer can reload the file list for the now-current branch.
	onWorkingTreeChanged: () => void
}) {
	const [branches, setBranches] = useState<Branch[]>([])
	const [loadState, setLoadState] = useState<LoadState>('loading')
	const [loadError, setLoadError] = useState('')
	const [actionError, setActionError] = useState('')
	const [notice, setNotice] = useState('')
	const [busy, setBusy] = useState(false)
	const [pending, setPending] = useState<PendingAction>(null)

	useEffect(() => {
		let cancelled = false
		const controller = new AbortController()

		void (async () => {
			setLoadState('loading')
			setLoadError('')
			try {
				const response = await fetch(`/api/projects/${encodeURIComponent(projectID)}/branches`, {
					signal: controller.signal,
				})
				if (!response.ok) {
					throw new Error(`Request failed with status ${response.status}`)
				}
				const parsed = parseBranches(await response.json())
				if (!cancelled) {
					setBranches(parsed)
					setLoadState('ready')
				}
			} catch (caught) {
				if (cancelled || controller.signal.aborted) {
					return
				}
				setLoadState('error')
				setLoadError(caught instanceof Error ? caught.message : 'Unknown error')
			}
		})()

		return () => {
			cancelled = true
			controller.abort()
		}
	}, [projectID])

	const sortedBranches = useMemo(
		() => [...branches].sort((left, right) => left.name.localeCompare(right.name)),
		[branches],
	)

	// Sends a branch action; on success returns the refreshed branch list, on a
	// git failure throws an Error carrying git's message for inline display.
	async function runAction(request: BranchActionRequest): Promise<Branch[]> {
		const response = await fetch(`/api/projects/${encodeURIComponent(projectID)}/branches`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request),
		})

		if (!response.ok) {
			let message = `Request failed with status ${response.status}`
			try {
				const payload: unknown = await response.json()
				if (
					typeof payload === 'object' &&
					payload !== null &&
					typeof (payload as Record<string, unknown>).error === 'string'
				) {
					message = (payload as { error: string }).error
				}
			} catch {
				// Non-JSON error body (plain text 400/500); keep the status message.
			}
			throw new Error(message)
		}

		return parseBranches(await response.json())
	}

	async function performAction(
		request: BranchActionRequest,
		options: { successNotice: string; touchesWorkingTree: boolean; closeOnSuccess?: boolean },
	) {
		setBusy(true)
		setActionError('')
		setNotice('')
		try {
			const next = await runAction(request)
			setBranches(next)
			setPending(null)
			if (options.touchesWorkingTree) {
				onWorkingTreeChanged()
			}
			if (options.closeOnSuccess) {
				onClose()
				return
			}
			setNotice(options.successNotice)
		} catch (caught) {
			setActionError(caught instanceof Error ? caught.message : 'Unknown error')
		} finally {
			setBusy(false)
		}
	}

	function handleCheckout(branch: Branch) {
		if (branch.isCurrent) {
			return
		}
		void performAction(
			{ action: 'checkout', branch: branch.name },
			{ successNotice: '', touchesWorkingTree: true, closeOnSuccess: true },
		)
	}

	function handleDelete(branch: Branch) {
		void performAction(
			{ action: 'delete', branch: branch.name },
			{ successNotice: `Deleted ${branch.name}.`, touchesWorkingTree: false },
		)
	}

	function handleCreateSubmit() {
		if (pending?.kind !== 'create') {
			return
		}
		const name = pending.name.trim()
		if (name === '') {
			return
		}
		void performAction(
			{ action: 'create', name, base: pending.base },
			{ successNotice: `Created ${name} off ${pending.base}.`, touchesWorkingTree: false },
		)
	}

	function handleMergeTarget(target: Branch) {
		if (pending?.kind !== 'merge') {
			return
		}
		if (target.name === pending.source) {
			return
		}
		void performAction(
			{ action: 'merge', source: pending.source, target: target.name },
			{
				successNotice: `Merged ${pending.source} into ${target.name}.`,
				touchesWorkingTree: true,
			},
		)
	}

	const mergeSource = pending?.kind === 'merge' ? pending.source : null

	return (
		<SearchOverlay
			title="Git branches"
			subtitle="Check out, create, delete, or merge local branches."
			onClose={onClose}
		>
			{mergeSource !== null ? (
				<div className="git-banner git-banner-merge" role="status">
					<span>
						Merging <strong>{mergeSource}</strong> into… pick a target branch.
					</span>
					<button type="button" className="git-banner-cancel" onClick={() => setPending(null)}>
						Cancel
					</button>
				</div>
			) : null}

			{actionError !== '' ? (
				<p className="git-message git-message-error" role="alert">
					{actionError}
				</p>
			) : null}
			{notice !== '' ? (
				<p className="git-message git-message-ok" role="status">
					{notice}
				</p>
			) : null}

			<div className="project-results-panel">
				{loadState === 'loading' ? <p className="project-status">Loading branches…</p> : null}
				{loadState === 'error' ? (
					<p className="project-status project-status-error">
						Could not load branches. {loadError}
					</p>
				) : null}
				{loadState === 'ready' && branches.length === 0 ? (
					<p className="project-status">No branches found.</p>
				) : null}
				{loadState === 'ready' && sortedBranches.length > 0 ? (
					<ul className="git-branch-list" role="list" aria-label="Branches">
						{sortedBranches.map((branch) => (
							<BranchRow
								key={branch.name}
								branch={branch}
								busy={busy}
								mergeSource={mergeSource}
								pending={pending}
								onCheckout={handleCheckout}
								onDelete={handleDelete}
								onStartCreate={(base) => {
									setNotice('')
									setActionError('')
									setPending({ kind: 'create', base, name: '' })
								}}
								onStartMerge={(source) => {
									setNotice('')
									setActionError('')
									setPending({ kind: 'merge', source })
								}}
								onMergeTarget={handleMergeTarget}
								onCreateNameChange={(name) =>
									setPending((previous) =>
										previous?.kind === 'create' ? { ...previous, name } : previous,
									)
								}
								onCreateSubmit={handleCreateSubmit}
								onCreateCancel={() => setPending(null)}
							/>
						))}
					</ul>
				) : null}
			</div>
		</SearchOverlay>
	)
}

function BranchRow({
	branch,
	busy,
	mergeSource,
	pending,
	onCheckout,
	onDelete,
	onStartCreate,
	onStartMerge,
	onMergeTarget,
	onCreateNameChange,
	onCreateSubmit,
	onCreateCancel,
}: {
	branch: Branch
	busy: boolean
	mergeSource: string | null
	pending: PendingAction
	onCheckout: (branch: Branch) => void
	onDelete: (branch: Branch) => void
	onStartCreate: (base: string) => void
	onStartMerge: (source: string) => void
	onMergeTarget: (branch: Branch) => void
	onCreateNameChange: (name: string) => void
	onCreateSubmit: () => void
	onCreateCancel: () => void
}) {
	const isMergeTargetMode = mergeSource !== null
	const isMergeSource = mergeSource === branch.name
	const isCreatingHere = pending?.kind === 'create' && pending.base === branch.name

	const handleRowClick = () => {
		if (busy) {
			return
		}
		if (isMergeTargetMode) {
			onMergeTarget(branch)
			return
		}
		onCheckout(branch)
	}

	return (
		<li className="git-branch-list-item" aria-current={branch.isCurrent ? 'true' : undefined}>
			<div
				className={
					branch.isCurrent ? 'git-row git-branch git-branch-current' : 'git-row git-branch'
				}
			>
				<button
					type="button"
					className="git-branch-select"
					onClick={handleRowClick}
					disabled={busy || (isMergeTargetMode && isMergeSource)}
					title={
						isMergeTargetMode
							? isMergeSource
								? 'Cannot merge a branch into itself'
								: `Merge ${mergeSource} into ${branch.name}`
							: branch.isCurrent
								? 'Current branch'
								: `Check out ${branch.name}`
					}
				>
					<span className="git-branch-icon" aria-hidden="true">
						{branch.isCurrent ? '●' : '○'}
					</span>
					<span className="git-label">{branch.name}</span>
					{branch.isCurrent ? <span className="git-current-badge">current</span> : null}
				</button>

				{!isMergeTargetMode ? (
					<span className="git-row-actions">
						<button
							type="button"
							className="git-action"
							onClick={() => onStartCreate(branch.name)}
							disabled={busy}
							title={`Create a branch off ${branch.name}`}
						>
							New
						</button>
						<button
							type="button"
							className="git-action"
							onClick={() => onStartMerge(branch.name)}
							disabled={busy}
							title={`Merge ${branch.name} into another branch`}
						>
							Merge
						</button>
						<button
							type="button"
							className="git-action git-action-danger"
							onClick={() => onDelete(branch)}
							disabled={busy || branch.isCurrent}
							title={
								branch.isCurrent ? 'Cannot delete the current branch' : `Delete ${branch.name}`
							}
						>
							Delete
						</button>
					</span>
				) : null}
			</div>

			{isCreatingHere ? (
				<form
					className="git-create-form"
					onSubmit={(event) => {
						event.preventDefault()
						onCreateSubmit()
					}}
				>
					<input
						type="text"
						className="git-create-input"
						value={pending.name}
						placeholder={`New branch off ${branch.name}`}
						autoFocus
						disabled={busy}
						onChange={(event) => onCreateNameChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								event.preventDefault()
								onCreateCancel()
							}
						}}
					/>
					<button
						type="submit"
						className="git-action git-action-primary"
						disabled={busy || pending.name.trim() === ''}
					>
						Create
					</button>
					<button type="button" className="git-action" onClick={onCreateCancel} disabled={busy}>
						Cancel
					</button>
				</form>
			) : null}
		</li>
	)
}
