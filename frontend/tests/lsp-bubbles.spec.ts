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

	// At least one symbol (e.g. the Greeter type / Greet method) is marked.
	const bubbles = viewer.locator('.lsp-bubble-dot')
	await expect(bubbles.first()).toBeVisible({ timeout: LSP_TIMEOUT })
	expect(await bubbles.count()).toBeGreaterThan(0)

	// Hovering a marked word reveals the cross-reference popover.
	const markedWord = viewer.locator('.lsp-token').first()
	await markedWord.hover()
	const popover = viewer.locator('.lsp-popover').first()
	await expect(popover).toBeVisible()
	await expect(popover).toContainText('References')
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
