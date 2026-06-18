import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
	highlightToLines,
	languageForFilename,
	type HighlightedToken,
} from './highlight'
import {
	buildLineMarks,
	referencesExcludingSelf,
	splitTokensWithMarks,
	type LineSegment,
	type LspLocation,
	type LspSymbol,
} from './lsp'

type OpenLocation = (path: string, line: number) => void

// The occurrence a popover is being shown for, so its own reference can be
// excluded from the references list.
type CurrentOccurrence = { file: string; line: number; character: number }

type CodeViewProps = {
	filename: string
	lines: string[]
	symbols?: LspSymbol[]
	// Zero-based line to scroll to and highlight once content is rendered.
	focusLine?: number | null
	// Identifies this window so bubble ids are unique across multiple windows.
	windowID: string
	// The single open bubble id across the whole app (or null), so opening one
	// closes any other.
	openBubble: string | null
	onBubbleChange: (id: string | null) => void
	onOpenLocation?: OpenLocation
}

type HighlightResult = {
	// Identity of the content these tokens were produced for, so tokens left
	// over from a previous file/content are ignored rather than shown stale.
	source: string[]
	tokens: HighlightedToken[][]
}

// Renders a file's contents with the line-number gutter. Syntax highlighting is
// applied asynchronously via Shiki; until (or unless) it resolves, lines render
// as plain text so content is never blocked on the highlighter. Words that the
// language server reported information for are marked with an LSP bubble; click
// the word to open a popover of clickable locations (only one open at a time).
export function CodeView({
	filename,
	lines,
	symbols,
	focusLine,
	windowID,
	openBubble,
	onBubbleChange,
	onOpenLocation,
}: CodeViewProps) {
	const [result, setResult] = useState<HighlightResult | null>(null)
	const focusedRowRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		const lang = languageForFilename(filename)
		if (!lang) {
			return
		}

		let cancelled = false
		highlightToLines(lines.join('\n'), lang)
			.then((tokens) => {
				if (!cancelled) {
					setResult({ source: lines, tokens })
				}
			})
			.catch(() => {
				// Grammar load or parse failure: leave the plain-text fallback.
			})

		return () => {
			cancelled = true
		}
	}, [filename, lines])

	// Scroll the focused line to the top of the window once the content (and thus
	// the row) exists, so the clicked location lands at the top, not the middle.
	useEffect(() => {
		if (focusLine == null) {
			return
		}
		focusedRowRef.current?.scrollIntoView({ block: 'start' })
	}, [focusLine, lines])

	// Only use tokens that match the lines currently being rendered.
	const highlighted = result?.source === lines ? result.tokens : null

	const lineMarks = useMemo(
		() => buildLineMarks(lines, symbols ?? [], filename),
		[lines, symbols, filename],
	)

	return (
		<div className="file-code" role="presentation">
			{lines.map((line, index) => {
				const tokens = highlighted?.[index]
				const baseTokens: HighlightedToken[] =
					tokens && tokens.length > 0 ? tokens : [{ content: line, color: undefined }]
				const marks = lineMarks.get(index) ?? []
				const segments = splitTokensWithMarks(baseTokens, marks)
				const isFocused = focusLine === index

				return (
					<div
						className={isFocused ? 'code-row code-row-focused' : 'code-row'}
						key={`${filename}:${index + 1}`}
						ref={isFocused ? focusedRowRef : undefined}
					>
						<span className="line-number">{index + 1}</span>
						<span className="line-content">
							{line === '' ? ' ' : segments.map((segment, segmentIndex) => (
								<CodeSegment
									key={segmentIndex}
									segment={segment}
									file={filename}
									line={index}
									windowID={windowID}
									openBubble={openBubble}
									onBubbleChange={onBubbleChange}
									onOpenLocation={onOpenLocation}
								/>
							))}
						</span>
					</div>
				)
			})}
		</div>
	)
}

function CodeSegment({
	segment,
	file,
	line,
	windowID,
	openBubble,
	onBubbleChange,
	onOpenLocation,
}: {
	segment: LineSegment
	file: string
	line: number
	windowID: string
	openBubble: string | null
	onBubbleChange: (id: string | null) => void
	onOpenLocation?: OpenLocation
}) {
	const style = segment.color ? { color: segment.color } : undefined
	const tokenRef = useRef<HTMLSpanElement>(null)

	if (!segment.symbol) {
		return <span style={style}>{segment.content}</span>
	}

	const bubbleID = `${windowID}:${line}:${segment.markStart ?? -1}`
	const open = openBubble === bubbleID
	const toggle = () => onBubbleChange(open ? null : bubbleID)

	return (
		<span
			ref={tokenRef}
			className={open ? 'lsp-token lsp-token-open' : 'lsp-token'}
			style={style}
			role="button"
			tabIndex={0}
			aria-expanded={open}
			aria-label={`Language server info for ${segment.symbol.name}`}
			onClick={toggle}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault()
					toggle()
				}
			}}
		>
			{segment.content}
			{segment.bubbleAnchor ? (
				<span className="lsp-bubble">
					<span className="lsp-bubble-dot" aria-hidden="true" />
					{open ? (
						<LspPopover
							symbol={segment.symbol}
							current={{ file, line, character: segment.markStart ?? -1 }}
							anchorRef={tokenRef}
							onClose={() => onBubbleChange(null)}
							onOpenLocation={onOpenLocation}
						/>
					) : null}
				</span>
			) : null}
		</span>
	)
}

const POPOVER_GAP = 8
const VIEWPORT_PADDING = 8

function LspPopover({
	symbol,
	current,
	anchorRef,
	onClose,
	onOpenLocation,
}: {
	symbol: LspSymbol
	current: CurrentOccurrence
	anchorRef: React.RefObject<HTMLElement | null>
	onClose: () => void
	onOpenLocation?: OpenLocation
}) {
	// References include the occurrence being viewed; drop it so the list only
	// shows other places the symbol appears.
	const references = referencesExcludingSelf(symbol, current.file, current.line, current.character)
	const total = symbol.definitions.length + references.length + symbol.implementations.length

	// Opening a location closes this popover as it opens the new window.
	const openLocation: OpenLocation | undefined = onOpenLocation
		? (path, line) => {
				onClose()
				onOpenLocation(path, line)
			}
		: undefined

	// Position the (portaled, fixed) popover from the anchor word's screen rect:
	// below it by default, flipped above when there isn't room, clamped to the
	// viewport. Recomputed while open as the window scrolls/zooms or resizes.
	const popoverRef = useRef<HTMLSpanElement>(null)
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

	useLayoutEffect(() => {
		const reposition = () => {
			const anchor = anchorRef.current
			const popover = popoverRef.current
			if (!anchor || !popover) {
				return
			}

			const anchorRect = anchor.getBoundingClientRect()
			const { width, height } = popover.getBoundingClientRect()
			const viewportWidth = window.innerWidth
			const viewportHeight = window.innerHeight

			let top = anchorRect.bottom + POPOVER_GAP
			const flippedTop = anchorRect.top - POPOVER_GAP - height
			// Flip above only if it doesn't fit below but does fit above.
			if (top + height > viewportHeight - VIEWPORT_PADDING && flippedTop >= VIEWPORT_PADDING) {
				top = flippedTop
			}
			top = Math.max(
				VIEWPORT_PADDING,
				Math.min(top, viewportHeight - height - VIEWPORT_PADDING),
			)

			const left = Math.max(
				VIEWPORT_PADDING,
				Math.min(anchorRect.left, viewportWidth - width - VIEWPORT_PADDING),
			)

			setPosition({ top, left })
		}

		reposition()
		// Capture phase so scrolling of inner containers (the code area, the
		// canvas) is observed, not just the window.
		window.addEventListener('scroll', reposition, true)
		window.addEventListener('resize', reposition)
		return () => {
			window.removeEventListener('scroll', reposition, true)
			window.removeEventListener('resize', reposition)
		}
	}, [anchorRef, symbol, references.length])

	return createPortal(
		// Stop clicks inside the popover from toggling the token open state.
		<span
			ref={popoverRef}
			className="lsp-popover"
			role="dialog"
			aria-label={`Language server info for ${symbol.name}`}
			style={{
				top: position?.top ?? 0,
				left: position?.left ?? 0,
				visibility: position ? 'visible' : 'hidden',
			}}
			onClick={(event) => event.stopPropagation()}
		>
			<span className="lsp-popover-header">
				<span className="lsp-popover-title">
					<span className="lsp-popover-kind">{symbol.kind}</span>
					{symbol.name}
				</span>
				<button
					type="button"
					className="lsp-popover-close"
					aria-label="Close"
					onClick={onClose}
				>
					×
				</button>
			</span>
			<LspLocationGroup
				label="Definitions"
				locations={symbol.definitions}
				onOpenLocation={openLocation}
			/>
			<LspLocationGroup
				label="References"
				locations={references}
				onOpenLocation={openLocation}
			/>
			<LspLocationGroup
				label="Implementations"
				locations={symbol.implementations}
				onOpenLocation={openLocation}
			/>
			{total === 0 ? <span className="lsp-popover-empty">No cross-references</span> : null}
		</span>,
		document.body,
	)
}

const MAX_LOCATIONS_SHOWN = 5

function LspLocationGroup({
	label,
	locations,
	onOpenLocation,
}: {
	label: string
	locations: LspLocation[]
	onOpenLocation?: OpenLocation
}) {
	if (locations.length === 0) {
		return null
	}

	return (
		<span className="lsp-popover-group">
			<span className="lsp-popover-label">
				{label}
				<span className="lsp-popover-count">{locations.length}</span>
			</span>
			{locations.slice(0, MAX_LOCATIONS_SHOWN).map((location, index) => (
				<LspLocationItem key={index} location={location} onOpenLocation={onOpenLocation} />
			))}
			{locations.length > MAX_LOCATIONS_SHOWN ? (
				<span className="lsp-popover-location lsp-popover-more">
					+{locations.length - MAX_LOCATIONS_SHOWN} more
				</span>
			) : null}
		</span>
	)
}

function LspLocationItem({
	location,
	onOpenLocation,
}: {
	location: LspLocation
	onOpenLocation?: OpenLocation
}) {
	// Project-relative paths are openable; absolute paths point outside the
	// project (standard library, dependencies) and cannot be loaded here.
	const inProject = !location.path.startsWith('/')
	const line = location.range.start.line
	const label = `${location.path}:${line + 1}`

	if (!inProject || !onOpenLocation) {
		return (
			<span
				className="lsp-popover-location lsp-popover-location-external"
				title={inProject ? undefined : 'Outside this project'}
			>
				{label}
			</span>
		)
	}

	return (
		<button
			type="button"
			className="lsp-popover-location lsp-popover-location-link"
			onClick={() => onOpenLocation(location.path, line)}
		>
			{label}
		</button>
	)
}
