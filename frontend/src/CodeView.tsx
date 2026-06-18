import { useEffect, useMemo, useRef, useState } from 'react'

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

	// Scroll the focused line into view once the content (and thus the row) exists.
	useEffect(() => {
		if (focusLine == null) {
			return
		}
		focusedRowRef.current?.scrollIntoView({ block: 'center' })
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

	if (!segment.symbol) {
		return <span style={style}>{segment.content}</span>
	}

	const bubbleID = `${windowID}:${line}:${segment.markStart ?? -1}`
	const open = openBubble === bubbleID
	const toggle = () => onBubbleChange(open ? null : bubbleID)

	return (
		<span
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
							onClose={() => onBubbleChange(null)}
							onOpenLocation={onOpenLocation}
						/>
					) : null}
				</span>
			) : null}
		</span>
	)
}

function LspPopover({
	symbol,
	current,
	onClose,
	onOpenLocation,
}: {
	symbol: LspSymbol
	current: CurrentOccurrence
	onClose: () => void
	onOpenLocation?: OpenLocation
}) {
	// References include the occurrence being viewed; drop it so the list only
	// shows other places the symbol appears.
	const references = referencesExcludingSelf(symbol, current.file, current.line, current.character)
	const total = symbol.definitions.length + references.length + symbol.implementations.length

	return (
		// Stop clicks inside the popover from toggling the token open state.
		<span
			className="lsp-popover"
			role="dialog"
			aria-label={`Language server info for ${symbol.name}`}
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
				onOpenLocation={onOpenLocation}
			/>
			<LspLocationGroup
				label="References"
				locations={references}
				onOpenLocation={onOpenLocation}
			/>
			<LspLocationGroup
				label="Implementations"
				locations={symbol.implementations}
				onOpenLocation={onOpenLocation}
			/>
			{total === 0 ? <span className="lsp-popover-empty">No cross-references</span> : null}
		</span>
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
