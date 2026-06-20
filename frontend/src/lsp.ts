import type { HighlightedToken } from './highlight'

// Mirrors the backend POST /api/projects/{id}/lsp response shape.
export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }
// defRange, when present, is the full line span of the declaration this location
// points at (e.g. a whole function body), so a definition can be opened showing
// just its lines. Set only on in-repo definition locations that resolve to a
// document symbol; absent for local variables/parameters and for
// references/implementations.
export type LspLocation = { uri: string; path: string; range: LspRange; defRange?: LspRange }
export type LspSymbol = {
	name: string
	kind: string
	position: LspPosition
	definitions: LspLocation[]
	references: LspLocation[]
	implementations: LspLocation[]
	// Every place this symbol appears within the analyzed file (to mark each).
	occurrences: LspRange[]
}
export type LspAnalysis = {
	file: string
	language: string
	symbols: LspSymbol[]
}

function isPosition(value: unknown): value is LspPosition {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const candidate = value as Record<string, unknown>
	return typeof candidate.line === 'number' && typeof candidate.character === 'number'
}

function isLocation(value: unknown): value is LspLocation {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const candidate = value as Record<string, unknown>
	const range = candidate.range as Record<string, unknown> | undefined
	return (
		typeof candidate.uri === 'string' &&
		typeof candidate.path === 'string' &&
		typeof range === 'object' &&
		range !== null &&
		isPosition(range.start) &&
		isPosition(range.end) &&
		// defRange is optional, but must be a valid range when present.
		(candidate.defRange === undefined || isRange(candidate.defRange))
	)
}

function isRange(value: unknown): value is LspRange {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const candidate = value as Record<string, unknown>
	return isPosition(candidate.start) && isPosition(candidate.end)
}

function isLocationArray(value: unknown): value is LspLocation[] {
	// The backend uses JSON null for empty location sets.
	if (value === null) {
		return true
	}
	return Array.isArray(value) && value.every(isLocation)
}

function isRangeArray(value: unknown): value is LspRange[] {
	if (value === null) {
		return true
	}
	return Array.isArray(value) && value.every(isRange)
}

function isSymbol(value: unknown): value is LspSymbol {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.name === 'string' &&
		typeof candidate.kind === 'string' &&
		isPosition(candidate.position) &&
		isLocationArray(candidate.definitions) &&
		isLocationArray(candidate.references) &&
		isLocationArray(candidate.implementations) &&
		isRangeArray(candidate.occurrences)
	)
}

// normalizeSymbol coerces null location/occurrence sets to empty arrays so the
// rest of the UI can treat them uniformly.
function normalizeSymbol(symbol: LspSymbol): LspSymbol {
	return {
		...symbol,
		definitions: symbol.definitions ?? [],
		references: symbol.references ?? [],
		implementations: symbol.implementations ?? [],
		occurrences: symbol.occurrences ?? [],
	}
}

export function parseLspAnalysis(value: unknown): LspAnalysis | null {
	if (typeof value !== 'object' || value === null) {
		return null
	}
	const candidate = value as Record<string, unknown>
	if (
		typeof candidate.file !== 'string' ||
		typeof candidate.language !== 'string' ||
		!Array.isArray(candidate.symbols) ||
		!candidate.symbols.every(isSymbol)
	) {
		return null
	}

	return {
		file: candidate.file,
		language: candidate.language,
		symbols: candidate.symbols.map(normalizeSymbol),
	}
}

export function hasLspInfo(symbol: LspSymbol): boolean {
	return (
		symbol.definitions.length > 0 ||
		symbol.references.length > 0 ||
		symbol.implementations.length > 0
	)
}

export function lspInfoCount(symbol: LspSymbol): number {
	return symbol.definitions.length + symbol.references.length + symbol.implementations.length
}

// locationAt reports whether a location sits exactly at the given position.
function locationAt(location: LspLocation, file: string, line: number, character: number): boolean {
	return (
		location.path === file &&
		location.range.start.line === line &&
		location.range.start.character === character
	)
}

// referencesExcludingSelf is the symbol's references with the occurrence
// currently being viewed removed (the location of the bubble you opened), since
// "a reference to the thing I'm looking at" is just itself.
export function referencesExcludingSelf(
	symbol: LspSymbol,
	file: string,
	line: number,
	character: number,
): LspLocation[] {
	return symbol.references.filter((reference) => !locationAt(reference, file, line, character))
}

// occurrenceHasNavigation reports whether an occurrence leads anywhere other
// than itself: a definition, an implementation, or some other reference. Used
// so occurrences with nothing to navigate to (e.g. a stdlib symbol used once,
// whose external definition was filtered out) don't get a useless bubble.
function occurrenceHasNavigation(
	symbol: LspSymbol,
	file: string,
	line: number,
	character: number,
): boolean {
	if (symbol.definitions.length > 0 || symbol.implementations.length > 0) {
		return true
	}
	return referencesExcludingSelf(symbol, file, line, character).length > 0
}

// A range within a single rendered line that should be marked as having LSP
// information, plus the symbol it belongs to.
export type SymbolMark = { start: number; end: number; symbol: LspSymbol }

const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_$]/u

// symbolWordEnd finds the end (exclusive) of the identifier that begins at
// `start`. The LSP only reports the start position, so we expand across
// identifier characters to underline the whole word. Non-identifier starts mark
// a single character.
export function symbolWordEnd(line: string, start: number): number {
	let end = start
	while (end < line.length && IDENTIFIER_CHARACTER.test(line[end])) {
		end += 1
	}
	return end > start ? end : Math.min(start + 1, line.length)
}

// buildLineMarks groups marks by line index. The backend reports every
// occurrence of each symbol within the analyzed file (including usages and
// symbols declared in other files), so we mark each occurrence range directly —
// skipping occurrences that have nowhere to navigate to. `currentFile` is the
// open file's project-relative path, matching the `path` on in-file locations.
export function buildLineMarks(
	lines: string[],
	symbols: LspSymbol[],
	currentFile: string,
): Map<number, SymbolMark[]> {
	const byLine = new Map<number, SymbolMark[]>()

	const addMark = (lineIndex: number, startChar: number, endChar: number, symbol: LspSymbol) => {
		const line = lines[lineIndex]
		if (line === undefined) {
			return
		}

		const start = Math.max(0, Math.min(startChar, line.length))
		// Trust the reported end when sane, else expand across the identifier.
		const end = endChar > start ? Math.min(endChar, line.length) : symbolWordEnd(line, start)
		const marks = byLine.get(lineIndex) ?? []
		// Skip a second mark at the same start so words never get stacked bubbles.
		if (!marks.some((mark) => mark.start === start)) {
			marks.push({ start, end, symbol })
			byLine.set(lineIndex, marks)
		}
	}

	const occurrencesOf = (symbol: LspSymbol) =>
		symbol.occurrences.length > 0
			? symbol.occurrences.map((range) => ({
					line: range.start.line,
					startChar: range.start.character,
					endChar: range.end.character,
				}))
			: [{ line: symbol.position.line, startChar: symbol.position.character, endChar: -1 }]

	for (const symbol of symbols) {
		for (const occurrence of occurrencesOf(symbol)) {
			if (!occurrenceHasNavigation(symbol, currentFile, occurrence.line, occurrence.startChar)) {
				continue
			}
			addMark(occurrence.line, occurrence.startChar, occurrence.endChar, symbol)
		}
	}

	for (const marks of byLine.values()) {
		marks.sort((left, right) => left.start - right.start)
	}
	return byLine
}

export type LineSegment = {
	content: string
	color?: string
	symbol?: LspSymbol
	// True only for the segment that contains the mark's first character, so the
	// bubble/popover is rendered once even when a word spans multiple tokens.
	bubbleAnchor?: boolean
	// Start character of the mark this segment belongs to (same for every segment
	// of one mark), identifying the occurrence for popover state.
	markStart?: number
}

// splitTokensWithMarks slices syntax-highlight tokens at mark boundaries so the
// marked portions can be wrapped with LSP affordances while preserving color.
export function splitTokensWithMarks(
	tokens: HighlightedToken[],
	marks: SymbolMark[],
): LineSegment[] {
	if (marks.length === 0) {
		return tokens.map((token) => ({ content: token.content, color: token.color }))
	}

	const segments: LineSegment[] = []
	let offset = 0

	for (const token of tokens) {
		const tokenStart = offset
		const tokenEnd = offset + token.content.length
		let cursor = tokenStart

		for (const mark of marks) {
			if (mark.end <= cursor || mark.start >= tokenEnd) {
				continue
			}

			const markStart = Math.max(mark.start, cursor)
			const markEnd = Math.min(mark.end, tokenEnd)

			if (markStart > cursor) {
				segments.push({
					content: token.content.slice(cursor - tokenStart, markStart - tokenStart),
					color: token.color,
				})
			}
			segments.push({
				content: token.content.slice(markStart - tokenStart, markEnd - tokenStart),
				color: token.color,
				symbol: mark.symbol,
				bubbleAnchor: markStart === mark.start,
				// Same for every segment of the mark, so clicking any part of the
				// word maps to one bubble identity.
				markStart: mark.start,
			})
			cursor = markEnd
		}

		if (cursor < tokenEnd) {
			segments.push({ content: token.content.slice(cursor - tokenStart), color: token.color })
		}
		offset = tokenEnd
	}

	return segments
}
