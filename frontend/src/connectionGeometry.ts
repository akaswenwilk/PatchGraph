// Types and screen-geometry helpers for connector lines, kept separate from the
// ConnectionsOverlay component so the component file exports only a component.

// An endpoint of a connector: either a symbol's bubble dot or a whole window.
export type DotAnchor = { kind: 'dot'; windowID: string; line: number; character: number }
export type WindowAnchor = { kind: 'window'; windowID: string }
export type Anchor = DotAnchor | WindowAnchor

// A connector always starts from a dot and ends at a dot or a window.
export type Connection = { id: string; source: DotAnchor; target: Anchor }

// An in-progress connector being dragged from a dot toward the pointer; snap is
// the anchor it would attach to if released now (null = free, won't be created).
export type ConnectionDraft = {
	source: DotAnchor
	pointer: { x: number; y: number }
	snap: Anchor | null
}

export type Point = { x: number; y: number }
export type Segment = { sx: number; sy: number; tx: number; ty: number }

// Pixels within which a dragged endpoint snaps to a dot or window.
const SNAP_DISTANCE = 36

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value))
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y)
}

function dotSelector(anchor: DotAnchor): string {
	return (
		`.lsp-bubble-dot[data-bubble-window="${anchor.windowID}"]` +
		`[data-bubble-line="${anchor.line}"][data-bubble-char="${anchor.character}"]`
	)
}

function windowElement(windowID: string): Element | null {
	return document.querySelector(`[data-window-id="${windowID}"]`)
}

function rectCenter(rect: DOMRect): Point {
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function nearestBorderPoint(rect: DOMRect, toward: Point): Point {
	return { x: clamp(toward.x, rect.left, rect.right), y: clamp(toward.y, rect.top, rect.bottom) }
}

// A dot's screen point, plus whether it is still visible inside its window's
// code viewport (a connector to a dot scrolled out of view is dropped).
function dotPoint(anchor: DotAnchor): { point: Point; inView: boolean } | null {
	const element = document.querySelector(dotSelector(anchor))
	if (!element) {
		return null
	}
	const point = rectCenter(element.getBoundingClientRect())
	const scroller = element.closest('.file-window')?.querySelector('.file-code-scroll')
	let inView = true
	if (scroller) {
		const view = scroller.getBoundingClientRect()
		inView =
			point.y >= view.top && point.y <= view.bottom && point.x >= view.left && point.x <= view.right
	}
	return { point, inView }
}

// Resolve an anchor to a screen point relative to the other endpoint (window
// anchors attach to their nearest border point).
export function anchorPoint(anchor: Anchor, relativeTo: Point): Point | null {
	if (anchor.kind === 'dot') {
		const resolved = dotPoint(anchor)
		return resolved ? resolved.point : null
	}
	const element = windowElement(anchor.windowID)
	return element ? nearestBorderPoint(element.getBoundingClientRect(), relativeTo) : null
}

// The source dot's screen point (null when it has gone), for the live draft.
export function sourcePoint(anchor: DotAnchor): Point | null {
	const resolved = dotPoint(anchor)
	return resolved ? resolved.point : null
}

// Resolve a committed connection's endpoints, or null if it should be removed
// (an endpoint element is gone, or a dot endpoint scrolled out of its window).
export function resolveConnection(connection: Connection): Segment | null {
	const source = dotPoint(connection.source)
	if (!source || !source.inView) {
		return null
	}
	if (connection.target.kind === 'dot') {
		const target = dotPoint(connection.target)
		if (!target || !target.inView) {
			return null
		}
		return { sx: source.point.x, sy: source.point.y, tx: target.point.x, ty: target.point.y }
	}
	const target = anchorPoint(connection.target, source.point)
	if (!target) {
		return null
	}
	return { sx: source.point.x, sy: source.point.y, tx: target.x, ty: target.y }
}

// findSnapAnchor returns the dot or window nearest to point (within
// SNAP_DISTANCE), excluding the source dot and its own window. null = free.
export function findSnapAnchor(point: Point, source: DotAnchor): Anchor | null {
	let best: Anchor | null = null
	let bestDistance = SNAP_DISTANCE

	for (const element of document.querySelectorAll('.lsp-bubble-dot')) {
		const windowID = element.getAttribute('data-bubble-window') ?? ''
		const line = Number(element.getAttribute('data-bubble-line'))
		const character = Number(element.getAttribute('data-bubble-char'))
		if (windowID === source.windowID && line === source.line && character === source.character) {
			continue
		}
		const candidateDistance = distance(point, rectCenter(element.getBoundingClientRect()))
		if (candidateDistance < bestDistance) {
			bestDistance = candidateDistance
			best = { kind: 'dot', windowID, line, character }
		}
	}

	for (const element of document.querySelectorAll('[data-window-id]')) {
		const windowID = element.getAttribute('data-window-id') ?? ''
		if (windowID === source.windowID) {
			continue
		}
		const candidateDistance = distance(
			point,
			nearestBorderPoint(element.getBoundingClientRect(), point),
		)
		if (candidateDistance < bestDistance) {
			bestDistance = candidateDistance
			best = { kind: 'window', windowID }
		}
	}

	return best
}
