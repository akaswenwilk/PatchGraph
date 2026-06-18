import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import {
	anchorPoint,
	resolveConnection,
	sourcePoint,
	type Connection,
	type ConnectionDraft,
	type Segment,
} from './connectionGeometry'

// ConnectionsOverlay draws committed connectors and the in-progress draft on a
// fixed, full-viewport SVG portaled to <body>. Endpoints are recomputed every
// frame from live DOM rects, so lines track windows during drag/scroll/zoom. A
// connection is removed when an endpoint disappears or its dot scrolls out of
// view. Connectors are selectable (a wide transparent hit line) for deletion.
export function ConnectionsOverlay({
	connections,
	draft,
	selectedID,
	onSelect,
	onRemove,
}: {
	connections: Connection[]
	draft: ConnectionDraft | null
	selectedID: string | null
	onSelect: (id: string) => void
	onRemove: (id: string) => void
}) {
	const visibleRefs = useRef<Map<string, SVGLineElement>>(new Map())
	const hitRefs = useRef<Map<string, SVGLineElement>>(new Map())
	const draftRef = useRef<SVGLineElement | null>(null)
	const onRemoveRef = useRef(onRemove)
	useEffect(() => {
		onRemoveRef.current = onRemove
	})

	useEffect(() => {
		if (connections.length === 0 && draft === null) {
			return
		}

		let frame = 0
		const apply = (line: SVGLineElement | undefined | null, segment: Segment) => {
			if (!line) {
				return
			}
			line.setAttribute('x1', String(segment.sx))
			line.setAttribute('y1', String(segment.sy))
			line.setAttribute('x2', String(segment.tx))
			line.setAttribute('y2', String(segment.ty))
			line.style.visibility = 'visible'
		}

		const tick = () => {
			for (const connection of connections) {
				const segment = resolveConnection(connection)
				if (!segment) {
					onRemoveRef.current(connection.id)
					continue
				}
				apply(visibleRefs.current.get(connection.id), segment)
				apply(hitRefs.current.get(connection.id), segment)
			}

			if (draft) {
				const source = sourcePoint(draft.source)
				if (source) {
					const end = draft.snap ? (anchorPoint(draft.snap, source) ?? draft.pointer) : draft.pointer
					apply(draftRef.current, { sx: source.x, sy: source.y, tx: end.x, ty: end.y })
				}
			}

			frame = requestAnimationFrame(tick)
		}

		frame = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(frame)
	}, [connections, draft])

	return createPortal(
		<svg className="connections-overlay" aria-hidden="true">
			{connections.map((connection) => {
				const selected = connection.id === selectedID
				return (
					<g key={connection.id}>
						<line
							ref={(element) => {
								if (element) visibleRefs.current.set(connection.id, element)
								else visibleRefs.current.delete(connection.id)
							}}
							className={selected ? 'connection-line connection-line-selected' : 'connection-line'}
							style={{ visibility: 'hidden' }}
						/>
						<line
							ref={(element) => {
								if (element) hitRefs.current.set(connection.id, element)
								else hitRefs.current.delete(connection.id)
							}}
							className="connection-hit-line"
							style={{ visibility: 'hidden' }}
							onPointerDown={(event) => event.stopPropagation()}
							onClick={(event) => {
								event.stopPropagation()
								onSelect(connection.id)
							}}
						/>
					</g>
				)
			})}
			{draft ? (
				<line
					ref={draftRef}
					className="connection-line connection-line-draft"
					style={{ visibility: 'hidden' }}
				/>
			) : null}
		</svg>,
		document.body,
	)
}
