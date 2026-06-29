import { expect, test, type Locator, type Page } from '@playwright/test'

async function openProject(page: Page, projectName: RegExp): Promise<Locator> {
	await page.getByRole('button', { name: 'Open Repo' }).click()
	const projectDialog = page.getByRole('dialog', { name: 'Open Repo' })
	await expect(projectDialog).toBeVisible()
	await projectDialog.getByRole('button', { name: projectName }).click()
	await projectDialog.getByRole('button', { name: 'Open', exact: true }).click()
	return projectDialog
}

test('switching repos updates the explorer tree without failing', async ({ page }) => {
	await page.goto('/')

	const projectDialog = await openProject(page, /PatchGraph\s+PatchGraph$/)

	await expect(page.getByRole('heading', { name: 'PatchGraph' })).toBeVisible()
	await expect(page.getByText('base.txt')).toBeVisible()

	await page.getByRole('button', { name: 'Switch Repo' }).click()
	await expect(projectDialog).toBeVisible()
	await projectDialog.getByRole('textbox', { name: 'Search repos' }).fill('worktree')
	await projectDialog
		.getByRole('button', { name: /PatchGraph-worktree\s+_worktrees\/PatchGraph-worktree$/ })
		.click()
	await projectDialog.getByRole('button', { name: 'Open', exact: true }).click()

	await expect(page.getByRole('heading', { name: 'PatchGraph-worktree' })).toBeVisible()
	await expect(page.getByText('worktree.txt')).toBeVisible()
	await expect(page.getByText(/Could not load files/i)).not.toBeVisible()
})

test('selecting a file opens its contents in the viewer', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)

	await page.getByRole('button', { name: /base\.txt/ }).click()

	await expect(page.getByRole('heading', { name: 'base.txt' })).toBeVisible()
	await expect(page.locator('.code-row').first().locator('.line-number')).toHaveText('1')
	await expect(page.locator('.code-row').first().locator('.line-content')).toHaveText('base')
	await expect(page.getByText('1 lines')).toBeVisible()

	const viewer = page.getByRole('region', { name: 'File viewer for base.txt' })
	await expect(viewer).toBeVisible()
	await page.getByRole('button', { name: 'Close base.txt' }).click()
	await expect(viewer).toHaveCount(0)
})

test('resizing the file viewer changes its size without changing code text size', async ({
	page,
}) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /base\.txt/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for base.txt' })
	const codeLine = page.locator('.code-row').first().locator('.line-content')
	const resizeHandle = page.getByRole('button', {
		name: 'Resize base.txt',
		exact: true,
	})

	await expect(viewer).toBeVisible()
	await viewer.hover()

	const beforeBox = await viewer.boundingBox()
	if (beforeBox === null) {
		throw new Error('Expected file viewer bounding box')
	}

	const beforeFontSize = await codeLine.evaluate(
		(element) => window.getComputedStyle(element).fontSize,
	)
	const handleBox = await resizeHandle.boundingBox()
	if (handleBox === null) {
		throw new Error('Expected resize handle bounding box')
	}

	await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
	await page.mouse.down()
	await page.mouse.move(handleBox.x + handleBox.width / 2 + 120, handleBox.y + handleBox.height / 2 + 80, {
		steps: 12,
	})
	await page.mouse.up()

	await expect
		.poll(() =>
			page.evaluate(() => window.getSelection?.()?.toString() ?? ''),
		)
		.toBe('')

	const afterBox = await viewer.boundingBox()
	if (afterBox === null) {
		throw new Error('Expected resized file viewer bounding box')
	}

	expect(afterBox.width).toBeGreaterThan(beforeBox.width + 40)
	expect(afterBox.height).toBeGreaterThan(beforeBox.height + 40)
	await expect
		.poll(() =>
			codeLine.evaluate((element) => window.getComputedStyle(element).fontSize),
		)
		.toBe(beforeFontSize)
})

test('file window titles stay readable when zoomed out and remain selectable', async ({
	page,
}) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /base\.txt/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for base.txt' })
	const title = viewer.locator('.file-window-title')
	const codeLine = page.locator('.code-row').first().locator('.line-content')
	const codeScroll = viewer.locator('.file-code-scroll')
	const workspace = page.locator('.workspace')

	await expect(viewer).toBeVisible()
	await expect(title).toHaveText('base.txt')

	const titleBefore = await title.boundingBox()
	const codeBefore = await codeLine.boundingBox()
	const codeViewportHeightBefore = await codeScroll.evaluate((element) => element.clientHeight)
	if (titleBefore === null || codeBefore === null) {
		throw new Error('Expected title and code bounding boxes before zoom')
	}

	const workspaceBox = await workspace.boundingBox()
	if (workspaceBox === null) {
		throw new Error('Expected workspace bounding box')
	}

	await page.mouse.move(workspaceBox.x + workspaceBox.width / 2, workspaceBox.y + workspaceBox.height / 2)
	await page.keyboard.down('Control')
	await page.mouse.wheel(0, 2000)
	await page.keyboard.up('Control')

	await expect
		.poll(() =>
			page.locator('.workspace-canvas').evaluate((element) => Number(getComputedStyle(element).zoom)),
		)
		.toBeLessThan(0.8)

	const titleAfter = await title.boundingBox()
	const codeAfter = await codeLine.boundingBox()
	const codeViewportHeightAfter = await codeScroll.evaluate((element) => element.clientHeight)
	if (titleAfter === null || codeAfter === null) {
		throw new Error('Expected title and code bounding boxes after zoom')
	}

	expect(titleAfter.height).toBeGreaterThan(titleBefore.height * 0.8)
	expect(codeAfter.height).toBeLessThan(codeBefore.height * 0.8)
	expect(codeViewportHeightAfter).toBeGreaterThanOrEqual(codeViewportHeightBefore - 2)

	const selectableTitle = await title.boundingBox()
	if (selectableTitle === null) {
		throw new Error('Expected selectable title bounding box')
	}
	await page.mouse.move(selectableTitle.x + 2, selectableTitle.y + selectableTitle.height / 2)
	await page.mouse.down()
	await page.mouse.move(
		selectableTitle.x + selectableTitle.width - 2,
		selectableTitle.y + selectableTitle.height / 2,
		{ steps: 8 },
	)
	await page.mouse.up()

	await expect
		.poll(() => page.evaluate(() => window.getSelection?.()?.toString() ?? ''))
		.toContain('base.txt')
})

test('dragging a window header moves it and expands the scrollable canvas', async ({
	page,
}) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /base\.txt/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for base.txt' })
	const header = viewer.locator('.file-window-header')
	const sidebar = page.getByRole('complementary', { name: 'Sidebar' })

	await expect(viewer).toBeVisible()

	// Read the window's canvas position from its transform (scroll-independent,
	// unlike boundingBox which shifts once the canvas grows and scrolls).
	const readTranslate = () =>
		viewer.evaluate((element) => {
			const matrix = new DOMMatrixReadOnly(window.getComputedStyle(element).transform)
			return { x: matrix.m41, y: matrix.m42 }
		})

	const beforeTranslate = await readTranslate()
	const headerBox = await header.boundingBox()
	if (headerBox === null) {
		throw new Error('Expected header bounding box')
	}

	// Grab an empty spot in the header's padding (not the title text or close button).
	const grabX = headerBox.x + 12
	const grabY = headerBox.y + 10
	const dragX = 360
	const dragY = 240

	await page.mouse.move(grabX, grabY)
	await page.mouse.down()
	await page.mouse.move(grabX + dragX, grabY + dragY, { steps: 12 })
	await page.mouse.up()

	// The window followed the pointer across the canvas.
	const afterTranslate = await readTranslate()
	expect(afterTranslate.x).toBeGreaterThan(beforeTranslate.x + dragX - 40)
	expect(afterTranslate.y).toBeGreaterThan(beforeTranslate.y + dragY - 40)

	// Dragging the window past the viewport grew the canvas into a scrollable area.
	const workspace = page.locator('.workspace')
	await expect
		.poll(() =>
			workspace.evaluate((element) => element.scrollWidth - element.clientWidth),
		)
		.toBeGreaterThan(0)

	// Dragging must not select text.
	await expect
		.poll(() => page.evaluate(() => window.getSelection?.()?.toString() ?? ''))
		.toBe('')

	// Scrolling the canvas moves the window but leaves the explorer pinned in place.
	await workspace.evaluate((element) => {
		element.scrollLeft = 0
	})
	const sidebarBefore = await sidebar.boundingBox()
	const windowBeforeScroll = await viewer.boundingBox()
	if (sidebarBefore === null || windowBeforeScroll === null) {
		throw new Error('Expected sidebar and window bounding boxes before scroll')
	}

	// Scroll as far right as the expanded canvas allows, then read back what the
	// browser actually applied (it clamps to the scrollable range).
	const appliedScroll = await workspace.evaluate((element) => {
		element.scrollLeft = element.scrollWidth
		return element.scrollLeft
	})
	expect(appliedScroll).toBeGreaterThan(20)

	const sidebarAfter = await sidebar.boundingBox()
	const windowAfterScroll = await viewer.boundingBox()
	if (sidebarAfter === null || windowAfterScroll === null) {
		throw new Error('Expected sidebar and window bounding boxes after scroll')
	}

	// The explorer is pinned; the file window shifts left by exactly the scroll.
	expect(sidebarAfter.x).toBe(sidebarBefore.x)
	expect(Math.abs(windowBeforeScroll.x - windowAfterScroll.x - appliedScroll)).toBeLessThan(2)
})

test('holding a dragged window at the viewport edge auto-scrolls the canvas', async ({
	page,
}) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /base\.txt/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for base.txt' })
	const header = viewer.locator('.file-window-header')
	const workspace = page.locator('.workspace')
	await expect(viewer).toBeVisible()

	const headerBox = await header.boundingBox()
	const viewport = page.viewportSize()
	if (headerBox === null || viewport === null) {
		throw new Error('Expected header bounding box and viewport size')
	}

	// Grab the header and drag into the bottom-right corner of the viewport, then
	// hold there without releasing so edge auto-scroll has to take over.
	await page.mouse.move(headerBox.x + 12, headerBox.y + 10)
	await page.mouse.down()
	await page.mouse.move(viewport.width - 4, viewport.height - 4, { steps: 12 })

	const scrollBefore = await workspace.evaluate((element) => ({
		left: element.scrollLeft,
		top: element.scrollTop,
	}))

	// No further pointer movement — the rAF auto-scroll loop must pan on its own.
	await expect
		.poll(() => workspace.evaluate((element) => element.scrollLeft), { timeout: 3000 })
		.toBeGreaterThan(scrollBefore.left + 40)
	await expect
		.poll(() => workspace.evaluate((element) => element.scrollTop), { timeout: 3000 })
		.toBeGreaterThan(scrollBefore.top + 40)

	await page.mouse.up()

	// Releasing stops the loop — scroll position settles.
	const settled = await workspace.evaluate((element) => element.scrollLeft)
	await page.waitForTimeout(250)
	const afterRelease = await workspace.evaluate((element) => element.scrollLeft)
	expect(Math.abs(afterRelease - settled)).toBeLessThan(2)
})

test('a previously-focused window can still be dragged after focusing another', async ({
	page,
}) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)

	const translateOf = (viewer: Locator) =>
		viewer.evaluate((element) => {
			const matrix = new DOMMatrixReadOnly(window.getComputedStyle(element).transform)
			return { x: matrix.m41, y: matrix.m42 }
		})

	// Drag a window's header by a fixed delta and return its before/after canvas
	// position (read from transform, so it's scroll-independent).
	const dragWindow = async (viewer: Locator, dx: number, dy: number) => {
		const header = viewer.locator('.file-window-header')
		const box = await header.boundingBox()
		if (box === null) {
			throw new Error('Expected header bounding box')
		}
		const before = await translateOf(viewer)
		await page.mouse.move(box.x + 12, box.y + 10)
		await page.mouse.down()
		await page.mouse.move(box.x + 12 + dx, box.y + 10 + dy, { steps: 10 })
		await page.mouse.up()
		const after = await translateOf(viewer)
		return { before, after }
	}

	// Open two windows. The second opens focused (highest z-index, last painted).
	await page.getByRole('button', { name: /base\.txt/ }).click()
	const first = page.getByRole('region', { name: 'File viewer for base.txt' })
	await expect(first).toBeVisible()
	await page.getByRole('button', { name: /second\.txt/ }).click()
	const second = page.getByRole('region', { name: 'File viewer for second.txt' })
	await expect(second).toBeVisible()

	// Both fresh-focused windows drag fine (this part always worked).
	const firstDrag = await dragWindow(first, 80, 60)
	expect(firstDrag.after.x).toBeGreaterThan(firstDrag.before.x + 40)
	const secondDrag = await dragWindow(second, 80, 60)
	expect(secondDrag.after.x).toBeGreaterThan(secondDrag.before.x + 40)

	// Regression: re-focusing the first window used to reorder the DOM nodes (the
	// list was sorted by z-index), which moved the captured header mid-gesture and
	// killed the drag. The window must still follow the pointer.
	const refocusDrag = await dragWindow(first, 140, 100)
	expect(refocusDrag.after.x).toBeGreaterThan(refocusDrag.before.x + 80)
	expect(refocusDrag.after.y).toBeGreaterThan(refocusDrag.before.y + 60)

	// And the gesture must end cleanly — no stuck 'grabbing' cursor on release.
	const bodyCursor = await page.evaluate(() => document.body.style.cursor)
	expect(bodyCursor).not.toBe('grabbing')
})

test('dragging a window up grows the workspace upward instead of clamping', async ({
	page,
}) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	// A second window anchors the bottom of the cluster so moving the first one up
	// visibly enlarges the canvas's vertical extent (and thus its scroll range).
	await page.getByRole('button', { name: /second\.txt/ }).click()
	await page.getByRole('button', { name: /base\.txt/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for base.txt' })
	const header = viewer.locator('.file-window-header')
	const workspace = page.locator('.workspace')
	await expect(viewer).toBeVisible()

	// Canvas-space Y of the window (independent of scroll), used to place it clear
	// of the viewport edge where dragging up would trigger auto-scroll.
	const translateY = await viewer.evaluate(
		(element) => new DOMMatrixReadOnly(window.getComputedStyle(element).transform).m42,
	)
	await workspace.evaluate((element, target) => {
		element.scrollTop = target
	}, translateY - 320)

	const box = await header.boundingBox()
	if (box === null) {
		throw new Error('Expected header bounding box')
	}
	const screenBefore = box.y
	const scrollHeightBefore = await workspace.evaluate((element) => element.scrollHeight)

	// Drag the top-most window straight up. Previously it clamped at the fixed
	// PAN_MARGIN edge; now the canvas origin grows to fit it.
	await page.mouse.move(box.x + 12, box.y + 10)
	await page.mouse.down()
	await page.mouse.move(box.x + 12, box.y + 10 - 200, { steps: 12 })
	await page.mouse.up()

	// The window stayed glued to the pointer on screen as it moved up.
	const screenAfter = (await header.boundingBox())?.y
	if (screenAfter === undefined) {
		throw new Error('Expected header bounding box after drag')
	}
	expect(screenBefore - screenAfter).toBeGreaterThan(100)

	// And the workspace adapted: its scrollable canvas grew taller to make room for
	// the window's new position above the rest of the cluster.
	const scrollHeightAfter = await workspace.evaluate((element) => element.scrollHeight)
	expect(scrollHeightAfter).toBeGreaterThan(scrollHeightBefore + 100)
})
