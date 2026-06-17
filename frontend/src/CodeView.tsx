import { useEffect, useMemo, useRef, useState } from 'react'

import {
	highlightToLines,
	languageForFilename,
	type HighlightedToken,
} from './highlight'
import {
	buildLineMarks,
	lspInfoCount,
	splitTokensWithMarks,
	type LineSegment,
	type LspLocation,
	type LspSymbol,
} from './lsp'

type OpenLocation = (path: string, line: number) => void

type CodeViewProps = {
	filename: string
	lines: string[]
	symbols?: LspSymbol[]
	// Zero-based line to scroll to and highlight once content is rendered.
	focusLine?: number | null
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
// language server reported information for are marked with an LSP bubble whose
// popover locations are clickable.
export function CodeView({ filename, lines, symbols, focusLine, onOpenLocation }: CodeViewProps) {
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

	const lineMarks = useMemo(() => buildLineMarks(lines, symbols ?? []), [lines, symbols])

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
	onOpenLocation,
}: {
	segment: LineSegment
	onOpenLocation?: OpenLocation
}) {
	const style = segment.color ? { color: segment.color } : undefined

	if (!segment.symbol) {
		return <span style={style}>{segment.content}</span>
	}

	return (
		<span
			className="lsp-token"
			style={style}
			tabIndex={0}
			aria-label={`Language server info for ${segment.symbol.name}`}
		>
			{segment.content}
			{segment.bubbleAnchor ? (
				<LspBubble symbol={segment.symbol} onOpenLocation={onOpenLocation} />
			) : null}
		</span>
	)
}

function LspBubble({
	symbol,
	onOpenLocation,
}: {
	symbol: LspSymbol
	onOpenLocation?: OpenLocation
}) {
	return (
		<span className="lsp-bubble">
			<span className="lsp-bubble-dot" aria-hidden="true" />
			<span className="lsp-popover" role="tooltip">
				<span className="lsp-popover-title">
					<span className="lsp-popover-kind">{symbol.kind}</span>
					{symbol.name}
				</span>
				<LspLocationGroup
					label="Definitions"
					locations={symbol.definitions}
					onOpenLocation={onOpenLocation}
				/>
				<LspLocationGroup
					label="References"
					locations={symbol.references}
					onOpenLocation={onOpenLocation}
				/>
				<LspLocationGroup
					label="Implementations"
					locations={symbol.implementations}
					onOpenLocation={onOpenLocation}
				/>
				{lspInfoCount(symbol) === 0 ? (
					<span className="lsp-popover-empty">No cross-references</span>
				) : null}
			</span>
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
