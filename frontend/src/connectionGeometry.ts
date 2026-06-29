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
// code viewport. A dot that is hidden or scrolled out of view is reported as
// not in view so the connector can fall back to the window border.
function dotPoint(anchor: DotAnchor): { point: Point; inView: boolean } | null {
	const element = document.querySelector(dotSelector(anchor))
	if (!element) {
		return null
	}
	const rect = element.getBoundingClientRect()
	// A collapsed window hides its code body with display:none, which yields a
	// zero-sized rect at the origin. Treat that as out of view so the connector
	// attaches to the window border instead of snapping to (0,0).
	if (rect.width === 0 && rect.height === 0) {
		return { point: rectCenter(rect), inView: false }
	}
	const point = rectCenter(rect)
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

// A resolved endpoint is either an exact dot point (dot present and in view) or
// a request to attach to the window's border (dot hidden/scrolled away, or a
// window-kind anchor). null means the window itself is gone (closed) and the
// connection should be removed.
type ResolvedEndpoint = { point: Point } | { rect: DOMRect } | null

// Resolve one endpoint. A dot endpoint keeps its exact point while the dot is
// visible; once the dot is hidden (collapsed window) or scrolled out of view it
// falls back to the window border so the connector stays attached to the window.
// Returns null only when the window element no longer exists.
function resolveEndpoint(anchor: Anchor): ResolvedEndpoint {
	if (anchor.kind === 'dot') {
		const resolved = dotPoint(anchor)
		if (resolved && resolved.inView) {
			return { point: resolved.point }
		}
	}
	const element = windowElement(anchor.windowID)
	return element ? { rect: element.getBoundingClientRect() } : null
}

// The reference point used to aim the *other* endpoint's border attachment: a
// dot point uses itself, a window fallback uses its center.
function endpointReference(endpoint: { point: Point } | { rect: DOMRect }): Point {
	return 'point' in endpoint ? endpoint.point : rectCenter(endpoint.rect)
}

// The final screen point for an endpoint: the exact dot point, or the window
// border point nearest the other endpoint.
function endpointFinalPoint(
	endpoint: { point: Point } | { rect: DOMRect },
	toward: Point,
): Point {
	return 'point' in endpoint ? endpoint.point : nearestBorderPoint(endpoint.rect, toward)
}

// Resolve a committed connection's endpoints, or null if it should be removed
// (a window endpoint no longer exists because the window was closed). Endpoints
// whose dot is hidden or scrolled away attach to the window border instead of
// being dropped, and reattach to the dot automatically once it is visible again.
export function resolveConnection(connection: Connection): Segment | null {
	const source = resolveEndpoint(connection.source)
	const target = resolveEndpoint(connection.target)
	if (!source || !target) {
		return null
	}
	const sourcePoint = endpointFinalPoint(source, endpointReference(target))
	const targetPoint = endpointFinalPoint(target, endpointReference(source))
	return { sx: sourcePoint.x, sy: sourcePoint.y, tx: targetPoint.x, ty: targetPoint.y }
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
