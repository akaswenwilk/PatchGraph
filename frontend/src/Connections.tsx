import { useEffect, useRef, type RefObject } from 'react'

import {
	anchorPoint,
	resolveConnection,
	sourcePoint,
	type Connection,
	type ConnectionDraft,
	type Segment,
} from './connectionGeometry'

// ConnectionsOverlay draws committed connectors and the in-progress draft on an
// SVG that lives *inside* the zoomed/scrolled canvas, sized to the canvas and
// using canvas-logical coordinates. Because the lines are part of the same
// scrolled+zoomed content as the windows, panning and zooming the canvas moves
// lines and windows together natively (compositor), with no per-frame JS — so
// they never lag behind. The rAF loop still recomputes endpoints every frame to
// cover the cases that move a dot/window *relative* to the canvas: window drag,
// resize, inner code-scroll, and the live draft. Geometry is computed in screen
// (client) coordinates and converted to canvas-logical space here, dividing out
// the current zoom. A connection is removed when an endpoint disappears or its
// dot scrolls out of view. Connectors are selectable (a wide transparent hit
// line) for deletion.
export function ConnectionsOverlay({
	connections,
	draft,
	selectedID,
	onSelect,
	onRemove,
	width,
	height,
	zoomRef,
}: {
	connections: Connection[]
	draft: ConnectionDraft | null
	selectedID: string | null
	onSelect: (id: string) => void
	onRemove: (id: string) => void
	width: number
	height: number
	zoomRef: RefObject<number>
}) {
	const svgRef = useRef<SVGSVGElement | null>(null)
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
		const tick = () => {
			const svg = svgRef.current
			if (!svg) {
				frame = requestAnimationFrame(tick)
				return
			}
			// The SVG fills the canvas, so its on-screen rect is the canvas content
			// origin (already scaled by zoom). Convert a client point into the SVG's
			// own (unscaled, canvas-logical) coordinate space by removing that origin
			// and dividing out the zoom.
			const rect = svg.getBoundingClientRect()
			const zoom = zoomRef.current || 1
			const apply = (line: SVGLineElement | undefined | null, segment: Segment) => {
				if (!line) {
					return
				}
				line.setAttribute('x1', String((segment.sx - rect.left) / zoom))
				line.setAttribute('y1', String((segment.sy - rect.top) / zoom))
				line.setAttribute('x2', String((segment.tx - rect.left) / zoom))
				line.setAttribute('y2', String((segment.ty - rect.top) / zoom))
				line.style.visibility = 'visible'
			}

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
	}, [connections, draft, zoomRef])

	return (
		<svg
			ref={svgRef}
			className="connections-overlay"
			width={width}
			height={height}
			aria-hidden="true">
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
		</svg>
	)
}
