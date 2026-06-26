import { expect, test, type Page } from '@playwright/test'

async function openProject(page: Page, projectName: RegExp): Promise<void> {
	await page.getByRole('button', { name: 'Open Repo' }).click()
	const projectDialog = page.getByRole('dialog', { name: 'Open Repo' })
	await expect(projectDialog).toBeVisible()
	await projectDialog.getByRole('button', { name: projectName }).click()
	await projectDialog.getByRole('button', { name: 'Open', exact: true }).click()
}

// gopls cold start + indexing can take a while in CI, so the LSP assertions
// get a generous timeout.
const LSP_TIMEOUT = 60_000

test('opening a Go file marks symbols with language-server bubbles', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /lib\.go/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for lib.go' })
	await expect(viewer).toBeVisible()

	// The header chip flips to a ready state once the analysis returns.
	await expect(viewer.locator('.file-window-lsp-ready')).toContainText(/LSP:\s*\d+\s*symbol/, {
		timeout: LSP_TIMEOUT,
	})

	// Symbols are marked at every in-file occurrence, not just declarations:
	// lib.go declares Greeter/Greet/Use and also uses Greeter and Greet inside
	// Use(), so there are more bubbles than the three declarations.
	const bubbles = viewer.locator('.lsp-bubble-dot')
	await expect(bubbles.first()).toBeVisible({ timeout: LSP_TIMEOUT })
	expect(await bubbles.count()).toBeGreaterThanOrEqual(4)

	// Clicking a marked word reveals the cross-reference popover (portaled to body).
	const markedWord = viewer.locator('.lsp-token').first()
	await markedWord.click()
	const popover = page.locator('.lsp-popover').first()
	await expect(popover).toBeVisible()
	await expect(popover).toContainText('Definitions')

	// It is portaled to <body> (overlaying the window, not clipped by its scroll)
	// and positioned fully within the viewport.
	await expect(page.locator('body > .lsp-popover')).toHaveCount(1)
	const popBox = await popover.boundingBox()
	const viewport = page.viewportSize()
	if (popBox && viewport) {
		expect(popBox.y).toBeGreaterThanOrEqual(-1)
		expect(popBox.y + popBox.height).toBeLessThanOrEqual(viewport.height + 1)
		expect(popBox.x).toBeGreaterThanOrEqual(-1)
		expect(popBox.x + popBox.width).toBeLessThanOrEqual(viewport.width + 1)
	}

	// The popover stays open until explicitly closed via its × button.
	await viewer.getByRole('heading', { name: 'lib.go' }).hover()
	await expect(popover).toBeVisible()
	await popover.getByRole('button', { name: 'Close' }).click()
	await expect(popover).toBeHidden()
})

test('opening a second bubble closes the first (only one popover at a time)', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /lib\.go/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for lib.go' })
	await expect(viewer.locator('.file-window-lsp-ready')).toBeVisible({ timeout: LSP_TIMEOUT })

	const tokens = viewer.locator('.lsp-token')
	await expect(tokens.nth(1)).toBeVisible({ timeout: LSP_TIMEOUT })

	// Open the first bubble's popover, then open a different bubble's.
	await tokens.nth(0).click()
	await expect(page.locator('.lsp-popover')).toHaveCount(1)

	await tokens.nth(1).click()
	// The first popover closed automatically; exactly one stays open.
	await expect(page.locator('.lsp-popover')).toHaveCount(1)
})

test('clicking an LSP location opens that file at the line in a new window', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /lib\.go/ }).click()

	const viewers = page.getByRole('region', { name: 'File viewer for lib.go' })
	const sourceViewer = viewers.first()
	await expect(sourceViewer.locator('.file-window-lsp-ready')).toBeVisible({ timeout: LSP_TIMEOUT })

	// Open the popover for the first marked symbol and click its first location.
	const token = sourceViewer.locator('.lsp-token').first()
	await token.click()
	const link = page.locator('.lsp-popover-location-link').first()
	await expect(link).toBeVisible()
	await link.click()

	// A second window for the same file opened, with the target line highlighted.
	await expect(viewers).toHaveCount(2, { timeout: LSP_TIMEOUT })
	await expect(page.locator('.code-row-focused').first()).toBeVisible()

	// Opening the location also closed the source popover.
	await expect(page.locator('.lsp-popover')).toHaveCount(0)
})

test('opening a definition loads the whole file, scrolled to the declaration', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /lib\.go/ }).click()

	const viewers = page.getByRole('region', { name: 'File viewer for lib.go' })
	const source = viewers.first()
	await expect(source.locator('.file-window-lsp-ready')).toBeVisible({ timeout: LSP_TIMEOUT })

	// The source window shows the whole file (several lines).
	const sourceRows = await source.locator('.code-row').count()
	expect(sourceRows).toBeGreaterThan(1)

	// Open a symbol's popover and follow its definition (the first link is under
	// the Definitions group, which renders first).
	await source.locator('.lsp-token').first().click()
	const popover = page.locator('.lsp-popover').first()
	await expect(popover).toContainText('Definitions')
	await popover
		.locator('.lsp-popover-group', { hasText: 'Definitions' })
		.locator('.lsp-popover-location-link')
		.first()
		.click()

	// The new window loads the full file (same row count as the source), not a
	// cropped slice, and highlights the declaration line it was opened at.
	await expect(viewers).toHaveCount(2, { timeout: LSP_TIMEOUT })
	const opened = viewers.nth(1)
	await expect(opened.locator('.code-row')).toHaveCount(sourceRows)
	await expect(opened.locator('.code-row-focused')).toHaveCount(1)
})

test('opening a file from a location draws a connector that clears when the window closes', async ({
	page,
}) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /lib\.go/ }).click()

	const viewers = page.getByRole('region', { name: 'File viewer for lib.go' })
	await expect(viewers.first().locator('.file-window-lsp-ready')).toBeVisible({
		timeout: LSP_TIMEOUT,
	})

	await viewers.first().locator('.lsp-token').first().click()
	await page.locator('.lsp-popover-location-link').first().click()
	await expect(viewers).toHaveCount(2, { timeout: LSP_TIMEOUT })

	// A connector line was drawn between the source dot and the new window.
	const lines = page.locator('.connections-overlay .connection-line')
	await expect(lines).toHaveCount(1)

	// Closing the opened window removes its connector.
	await viewers.nth(1).getByRole('button', { name: /^Close / }).click()
	await expect(viewers).toHaveCount(1)
	await expect(lines).toHaveCount(0)
})

test('a connector can be drawn between two dots, then selected and deleted', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /lib\.go/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for lib.go' })
	await expect(viewer.locator('.file-window-lsp-ready')).toBeVisible({ timeout: LSP_TIMEOUT })

	const dots = page.locator('.lsp-bubble-dot')
	await expect(dots.nth(1)).toBeVisible({ timeout: LSP_TIMEOUT })
	const a = await dots.nth(0).boundingBox()
	const b = await dots.nth(1).boundingBox()
	if (a === null || b === null) {
		throw new Error('Expected two bubble dots')
	}
	const aCenter = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
	const bCenter = { x: b.x + b.width / 2, y: b.y + b.height / 2 }

	const lines = page.locator('.connections-overlay .connection-line')
	await expect(lines).toHaveCount(0)

	// Drag from one dot to another: it snaps and creates a connector.
	await page.mouse.move(aCenter.x, aCenter.y)
	await page.mouse.down()
	await page.mouse.move(bCenter.x, bCenter.y, { steps: 12 })
	await page.mouse.up()
	await expect(lines).toHaveCount(1)
	await expect(lines.first()).toBeVisible()

	// Click the connector to select it, then Backspace to delete it.
	await page.mouse.click((aCenter.x + bCenter.x) / 2, (aCenter.y + bCenter.y) / 2)
	await expect(page.locator('.connection-line-selected')).toHaveCount(1)
	await page.keyboard.press('Backspace')
	await expect(lines).toHaveCount(0)
})

test('a connector dragged onto nothing is not created', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /lib\.go/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for lib.go' })
	await expect(viewer.locator('.file-window-lsp-ready')).toBeVisible({ timeout: LSP_TIMEOUT })

	const dot = page.locator('.lsp-bubble-dot').first()
	const box = await dot.boundingBox()
	if (box === null) {
		throw new Error('Expected a bubble dot')
	}

	// Drag from a dot out onto empty canvas (far from any dot/window) and release.
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	await page.mouse.down()
	await page.mouse.move(box.x + 600, box.y + 360, { steps: 12 })
	await page.mouse.up()

	await expect(page.locator('.connections-overlay .connection-line')).toHaveCount(0)
})

test('opening a plain-text file shows no language-server bubbles', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /base\.txt/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for base.txt' })
	await expect(viewer).toBeVisible()
	// Wait until the file body has rendered before asserting the absence of bubbles.
	await expect(viewer.locator('.code-row').first().locator('.line-content')).toHaveText('base')

	// Unsupported language: no ready chip, no bubbles.
	await expect(viewer.locator('.lsp-bubble-dot')).toHaveCount(0)
	await expect(viewer.locator('.file-window-lsp-ready')).toHaveCount(0)
})
