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
