import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// A Miro-style connector created when a file window is opened from an LSP
// location: it ties the source symbol's bubble dot to the opened window.
export type Connection = {
	id: string
	// Identifies the source bubble dot (matches its data-bubble-* attributes).
	sourceWindowID: string
	sourceLine: number
	sourceCharacter: number
	// The window the line attaches to.
	targetWindowID: string
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value))
}

// ConnectionsOverlay draws each connection as a line on a fixed, full-viewport
// SVG portaled to <body>. Endpoints are recomputed every frame from live DOM
// rects, so lines track windows as they are dragged, scrolled, or zoomed. A
// connection is removed permanently once its source dot scrolls out of the
// source window's code view (or either endpoint's element disappears).
export function ConnectionsOverlay({
	connections,
	onRemove,
}: {
	connections: Connection[]
	onRemove: (id: string) => void
}) {
	const lineRefs = useRef<Map<string, SVGLineElement>>(new Map())
	const onRemoveRef = useRef(onRemove)
	useEffect(() => {
		onRemoveRef.current = onRemove
	})

	useEffect(() => {
		if (connections.length === 0) {
			return
		}

		let frame = 0
		const tick = () => {
			for (const connection of connections) {
				const line = lineRefs.current.get(connection.id)
				if (!line) {
					continue
				}

				const dot = document.querySelector(
					`.lsp-bubble-dot[data-bubble-window="${connection.sourceWindowID}"]` +
						`[data-bubble-line="${connection.sourceLine}"]` +
						`[data-bubble-char="${connection.sourceCharacter}"]`,
				)
				const target = document.querySelector(`[data-window-id="${connection.targetWindowID}"]`)
				if (!dot || !target) {
					onRemoveRef.current(connection.id)
					continue
				}

				const dotRect = dot.getBoundingClientRect()
				const sourceX = dotRect.left + dotRect.width / 2
				const sourceY = dotRect.top + dotRect.height / 2

				// Disappear permanently once the dot leaves its window's code viewport.
				const scroller = dot.closest('.file-window')?.querySelector('.file-code-scroll')
				if (scroller) {
					const view = scroller.getBoundingClientRect()
					if (
						sourceY < view.top ||
						sourceY > view.bottom ||
						sourceX < view.left ||
						sourceX > view.right
					) {
						onRemoveRef.current(connection.id)
						continue
					}
				}

				// Attach to the point on the target window's border nearest the dot.
				const targetRect = target.getBoundingClientRect()
				const targetX = clamp(sourceX, targetRect.left, targetRect.right)
				const targetY = clamp(sourceY, targetRect.top, targetRect.bottom)

				line.setAttribute('x1', String(sourceX))
				line.setAttribute('y1', String(sourceY))
				line.setAttribute('x2', String(targetX))
				line.setAttribute('y2', String(targetY))
				line.style.visibility = 'visible'
			}

			frame = requestAnimationFrame(tick)
		}

		frame = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(frame)
	}, [connections])

	return createPortal(
		<svg className="connections-overlay" aria-hidden="true">
			{connections.map((connection) => (
				<line
					key={connection.id}
					ref={(element) => {
						if (element) {
							lineRefs.current.set(connection.id, element)
						} else {
							lineRefs.current.delete(connection.id)
						}
					}}
					className="connection-line"
					style={{ visibility: 'hidden' }}
				/>
			))}
		</svg>,
		document.body,
	)
}
