import { SearchOverlay } from './SearchPalette'

// Workspace settings, shown in a modal window like the git branch menu. Today it
// holds a single toggle controlling how the LSP info list opens locations: either
// always cascading a new window, or jumping to (and connecting) an already-open
// window for that file.
export function SettingsMenu({
	lspOpensNewWindow,
	onLspOpensNewWindowChange,
	onClose,
}: {
	lspOpensNewWindow: boolean
	onLspOpensNewWindowChange: (value: boolean) => void
	onClose: () => void
}) {
	// The toggle reads as "jump to existing window", which is the inverse of the
	// stored "always open a new window" flag.
	const jumpToExisting = !lspOpensNewWindow

	return (
		<SearchOverlay
			title="Settings"
			subtitle="Configure how PatchGraph opens windows."
			onClose={onClose}
		>
			<div className="settings-panel">
				<div className="settings-row">
					<div className="settings-row-text">
						<p className="settings-row-title">LSP navigation</p>
						<p className="settings-row-description">
							When you open a definition or reference whose file is already open,
							jump to that window and draw a connector instead of opening a
							duplicate. Turn this off to always cascade a new window.
						</p>
					</div>

					<button
						type="button"
						role="switch"
						aria-checked={jumpToExisting}
						className={
							jumpToExisting ? 'settings-toggle settings-toggle-on' : 'settings-toggle'
						}
						onClick={() => onLspOpensNewWindowChange(!lspOpensNewWindow)}
					>
						<span className="settings-toggle-track" aria-hidden="true">
							<span className="settings-toggle-thumb" />
						</span>
						<span className="settings-toggle-label">
							{jumpToExisting ? 'Jump to existing window' : 'Always open a new window'}
						</span>
					</button>
				</div>
			</div>
		</SearchOverlay>
	)
}
