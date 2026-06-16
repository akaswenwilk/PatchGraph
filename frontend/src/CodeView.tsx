import { useEffect, useState } from 'react'

import {
	highlightToLines,
	languageForFilename,
	type HighlightedToken,
} from './highlight'

type CodeViewProps = {
	filename: string
	lines: string[]
}

type HighlightResult = {
	// Identity of the content these tokens were produced for, so tokens left
	// over from a previous file/content are ignored rather than shown stale.
	source: string[]
	tokens: HighlightedToken[][]
}

// Renders a file's contents with the line-number gutter. Syntax highlighting is
// applied asynchronously via Shiki; until (or unless) it resolves, lines render
// as plain text so content is never blocked on the highlighter.
export function CodeView({ filename, lines }: CodeViewProps) {
	const [result, setResult] = useState<HighlightResult | null>(null)

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

	// Only use tokens that match the lines currently being rendered.
	const highlighted = result?.source === lines ? result.tokens : null

	return (
		<div className="file-code" role="presentation">
			{lines.map((line, index) => {
				const tokens = highlighted?.[index]
				return (
					<div className="code-row" key={`${filename}:${index + 1}`}>
						<span className="line-number">{index + 1}</span>
						<span className="line-content">
							{tokens && tokens.length > 0 ? (
								tokens.map((token, tokenIndex) => (
									<span
										key={tokenIndex}
										style={token.color ? { color: token.color } : undefined}
									>
										{token.content}
									</span>
								))
							) : line === '' ? (
								' '
							) : (
								line
							)}
						</span>
					</div>
				)
			})}
		</div>
	)
}
