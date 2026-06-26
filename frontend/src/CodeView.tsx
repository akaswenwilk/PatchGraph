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
import type { DotAnchor } from './connectionGeometry'

// Begin dragging a new connector from a bubble dot.
type StartConnection = (source: DotAnchor, clientX: number, clientY: number) => void

// The inclusive line span (zero-based) a window should show, instead of the
// whole file — used to open a definition as just its own lines.
// Handler used by location items: open the file at a line. The whole file is
// always loaded into the new window; the line is scrolled to and highlighted.
type OpenLocation = (path: string, line: number) => void

// Handler at the CodeView boundary: also carries the source occurrence (the
// bubble the location was opened from) so a connector can be drawn from it.
type OpenLocationFromSymbol = (
	path: string,
	line: number,
	source: { line: number; character: number },
) => void

// The occurrence a popover is being shown for, so its own reference can be
// excluded from the references list and used as a connector's source.
type CurrentOccurrence = { file: string; line: number; character: number }

type CodeViewProps = {
	filename: string
	lines: string[]
	diffLines?: DiffLineMeta[] | null
	symbols?: LspSymbol[]
	// Zero-based line to scroll to and highlight once content is rendered.
	focusLine?: number | null
	// Identifies this window so bubble ids are unique across multiple windows.
	windowID: string
	// The single open bubble id across the whole app (or null), so opening one
	// closes any other.
	openBubble: string | null
	onBubbleChange: (id: string | null) => void
	onOpenLocation?: OpenLocationFromSymbol
	onStartConnection?: StartConnection
	onExpandCollapsedDiff?: (lineIndex: number, direction: 'up' | 'down') => void
}

export type DiffLineMeta = {
	kind: 'context' | 'added' | 'removed' | 'collapsed'
	oldLine?: number
	newLine?: number
	changes?: DiffLineChange[]
	hidden?: DiffHiddenLine[]
}

export type DiffHiddenLine = {
	text: string
	kind: 'context'
	oldLine?: number
	newLine?: number
	changes?: DiffLineChange[]
}

export type DiffLineChange = {
	start: number
	end: number
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
	diffLines,
	symbols,
	focusLine,
	windowID,
	openBubble,
	onBubbleChange,
	onOpenLocation,
	onStartConnection,
	onExpandCollapsedDiff,
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

	const lineMarks = useMemo(() => {
		if (!diffLines) {
			return buildLineMarks(lines, symbols ?? [], filename)
		}

		const newSideLines: string[] = []
		for (const [displayIndex, meta] of diffLines.entries()) {
			if (meta.newLine !== undefined) {
				newSideLines[meta.newLine - 1] = lines[displayIndex]
			}
		}

		const sourceMarks = buildLineMarks(newSideLines, symbols ?? [], filename)
		const remapped = new Map<number, NonNullable<ReturnType<typeof sourceMarks.get>>>()
		for (const [displayIndex, meta] of diffLines.entries()) {
			if (meta.newLine === undefined) {
				continue
			}
			const marks = sourceMarks.get(meta.newLine - 1)
			if (marks) {
				remapped.set(displayIndex, marks)
			}
		}
		return remapped
	}, [lines, symbols, filename, diffLines])

	return (
		<div className="file-code" role="presentation">
			{lines.map((line, index) => {
				const tokens = highlighted?.[index]
				const baseTokens: HighlightedToken[] =
					tokens && tokens.length > 0 ? tokens : [{ content: line, color: undefined }]
				const marks = lineMarks.get(index) ?? []
				const isFocused = focusLine === index
				const diffMeta = diffLines?.[index] ?? null
				if (diffMeta?.kind === 'collapsed') {
					const hiddenCount = diffMeta.hidden?.length ?? 0
					return (
						<div
							className="code-row code-row-diff code-row-collapsed"
							key={`${filename}:${index + 1}:collapsed`}
							ref={isFocused ? focusedRowRef : undefined}
						>
							<span className="line-number" />
							<span className="line-content">
								<button
									type="button"
									className="diff-expand-button"
									onClick={() => onExpandCollapsedDiff?.(index, 'up')}
									disabled={hiddenCount === 0}
								>
									{hiddenCount > 0
										? `Show 10 lines up (${hiddenCount} hidden)`
										: 'No hidden lines'}
								</button>
								<button
									type="button"
									className="diff-expand-button"
									onClick={() => onExpandCollapsedDiff?.(index, 'down')}
									disabled={hiddenCount === 0}
								>
									{hiddenCount > 0
										? `Show 10 lines down (${hiddenCount} hidden)`
										: 'No hidden lines'}
								</button>
							</span>
						</div>
					)
				}

				const segments = splitTokensWithMarks(baseTokens, marks)
				const renderedSegments = splitSegmentsWithDiffHighlights(segments, diffMeta?.changes ?? [])
				const rowClassName = [
					'code-row',
					isFocused ? 'code-row-focused' : '',
					diffMeta ? `code-row-diff code-row-${diffMeta.kind}` : '',
				]
					.filter(Boolean)
					.join(' ')
				const renderedLineNumber = diffMeta
					? diffMeta.kind === 'removed'
						? diffMeta.oldLine
						: diffMeta.newLine
					: index + 1
				const symbolLine = diffMeta?.newLine === undefined ? index : diffMeta.newLine - 1

				return (
					<div
						className={rowClassName}
						key={`${filename}:${index + 1}`}
						ref={isFocused ? focusedRowRef : undefined}
					>
						<span className="line-number">{renderedLineNumber ?? ''}</span>
						<span className="line-content">
							{line === '' ? ' ' : renderedSegments.map((segment, segmentIndex) => (
								<CodeSegment
									key={segmentIndex}
									segment={segment}
									file={filename}
									line={symbolLine}
									windowID={windowID}
									openBubble={openBubble}
									onBubbleChange={onBubbleChange}
									onOpenLocation={onOpenLocation}
									onStartConnection={onStartConnection}
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
	onStartConnection,
}: {
	segment: RenderedLineSegment
	file: string
	line: number
	windowID: string
	openBubble: string | null
	onBubbleChange: (id: string | null) => void
	onOpenLocation?: OpenLocationFromSymbol
	onStartConnection?: StartConnection
}) {
	const style = segment.color ? { color: segment.color } : undefined
	const tokenRef = useRef<HTMLSpanElement>(null)

	if (!segment.symbol) {
		return (
			<span className={segment.diffChanged ? 'diff-inline-change' : undefined} style={style}>
				{segment.content}
			</span>
		)
	}

	const bubbleID = `${windowID}:${line}:${segment.markStart ?? -1}`
	const open = openBubble === bubbleID
	const toggle = () => onBubbleChange(open ? null : bubbleID)

	return (
		<span
			ref={tokenRef}
			className={[
				open ? 'lsp-token lsp-token-open' : 'lsp-token',
				segment.diffChanged ? 'diff-inline-change' : '',
			]
				.filter(Boolean)
				.join(' ')}
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
					<span
						className="lsp-bubble-dot"
						data-bubble-window={windowID}
						data-bubble-line={line}
						data-bubble-char={segment.markStart ?? -1}
						title="Drag to connect"
						onPointerDown={(event) => {
							// Start drawing a connector; don't toggle the popover or focus.
							event.stopPropagation()
							event.preventDefault()
							onStartConnection?.(
								{
									kind: 'dot',
									windowID,
									line,
									character: segment.markStart ?? -1,
								},
								event.clientX,
								event.clientY,
							)
						}}
						onClick={(event) => event.stopPropagation()}
					/>
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

type RenderedLineSegment = LineSegment & {
	diffChanged?: boolean
}

function splitSegmentsWithDiffHighlights(
	segments: LineSegment[],
	changes: DiffLineChange[],
): RenderedLineSegment[] {
	if (changes.length === 0) {
		return segments
	}

	const sortedChanges = [...changes].sort((left, right) => left.start - right.start)
	const rendered: RenderedLineSegment[] = []
	let offset = 0

	for (const segment of segments) {
		const segmentStart = offset
		const segmentEnd = offset + segment.content.length
		let cursor = segmentStart
		let bubbleAnchorUsed = false

		const sliceSegment = (start: number, end: number, diffChanged = false): RenderedLineSegment => {
			const bubbleAnchor = Boolean(segment.bubbleAnchor && !bubbleAnchorUsed && start === segmentStart)
			if (bubbleAnchor) {
				bubbleAnchorUsed = true
			}
			return {
				...segment,
				content: segment.content.slice(start - segmentStart, end - segmentStart),
				bubbleAnchor,
				diffChanged,
			}
		}

		for (const change of sortedChanges) {
			if (change.end <= cursor || change.start >= segmentEnd) {
				continue
			}
			const changeStart = Math.max(change.start, cursor)
			const changeEnd = Math.min(change.end, segmentEnd)
			if (changeStart > cursor) {
				rendered.push(sliceSegment(cursor, changeStart))
			}
			rendered.push(sliceSegment(changeStart, changeEnd, true))
			cursor = changeEnd
		}

		if (cursor < segmentEnd) {
			rendered.push(sliceSegment(cursor, segmentEnd))
		}
		offset = segmentEnd
	}

	return rendered
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
	onOpenLocation?: OpenLocationFromSymbol
}) {
	// References include the occurrence being viewed; drop it so the list only
	// shows other places the symbol appears.
	const references = referencesExcludingSelf(symbol, current.file, current.line, current.character)
	const total = symbol.definitions.length + references.length + symbol.implementations.length

	// Opening a location closes this popover and passes the source occurrence
	// (this bubble) so a connector line can be drawn from it to the new window.
	const openLocation: OpenLocation | undefined = onOpenLocation
		? (path, line) => {
				onClose()
				onOpenLocation(path, line, { line: current.line, character: current.character })
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
				<LspLocationItem
					key={index}
					location={location}
					onOpenLocation={onOpenLocation}
				/>
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
