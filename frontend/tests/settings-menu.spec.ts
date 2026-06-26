import { expect, test, type Page } from '@playwright/test'

async function openProject(page: Page, projectName: RegExp): Promise<void> {
	await page.getByRole('button', { name: 'Open Repo' }).click()
	const projectDialog = page.getByRole('dialog', { name: 'Open Repo' })
	await expect(projectDialog).toBeVisible()
	await projectDialog.getByRole('button', { name: projectName }).click()
	await projectDialog.getByRole('button', { name: 'Open', exact: true }).click()
}

test('the settings gear opens a menu and toggles LSP window behavior', async ({ page }) => {
	await page.goto('/')
	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await expect(page.getByText('base.txt')).toBeVisible()

	await page.getByRole('button', { name: 'Settings' }).click()
	const dialog = page.getByRole('dialog', { name: 'Settings' })
	await expect(dialog).toBeVisible()

	// Default is jump-to-existing, so the switch is on.
	const toggle = dialog.getByRole('switch')
	await expect(toggle).toHaveAttribute('aria-checked', 'true')
	await expect(toggle).toContainText('Jump to existing window')

	// Flipping it switches to always opening a new window, and the choice persists
	// across a reload.
	await toggle.click()
	await expect(toggle).toHaveAttribute('aria-checked', 'false')
	await expect(toggle).toContainText('Always open a new window')

	await page.reload()
	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: 'Settings' }).click()
	await expect(
		page.getByRole('dialog', { name: 'Settings' }).getByRole('switch'),
	).toHaveAttribute('aria-checked', 'false')
})

test('clicking an LSP location jumps to the file when it is already open', async ({ page }) => {
	const LSP_TIMEOUT = 30_000
	await page.goto('/')
	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /lib\.go/ }).click()

	const viewers = page.getByRole('region', { name: 'File viewer for lib.go' })
	const source = viewers.first()
	await expect(source.locator('.file-window-lsp-ready')).toBeVisible({ timeout: LSP_TIMEOUT })

	// Follow a location once: it opens the target file in a second window.
	await source.locator('.lsp-token').first().click()
	await page.locator('.lsp-popover-location-link').first().click()
	await expect(viewers).toHaveCount(2, { timeout: LSP_TIMEOUT })

	// Following the same location again (default jump-to-existing) focuses the
	// existing window instead of cascading a third one.
	await source.locator('.lsp-token').first().click()
	await page.locator('.lsp-popover-location-link').first().click()
	await expect(viewers).toHaveCount(2)
})

test('with the toggle off, following a location always opens a new window', async ({ page }) => {
	const LSP_TIMEOUT = 30_000
	await page.goto('/')
	await openProject(page, /PatchGraph\s+PatchGraph$/)

	// Turn the setting off: always open a new window.
	await page.getByRole('button', { name: 'Settings' }).click()
	const dialog = page.getByRole('dialog', { name: 'Settings' })
	await dialog.getByRole('switch').click()
	await expect(dialog.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
	await page.keyboard.press('Escape')
	await expect(dialog).toBeHidden()

	await page.getByRole('button', { name: /lib\.go/ }).click()
	const viewers = page.getByRole('region', { name: 'File viewer for lib.go' })
	const source = viewers.first()
	await expect(source.locator('.file-window-lsp-ready')).toBeVisible({ timeout: LSP_TIMEOUT })

	// Follow the same location twice: each follow cascades another window even
	// though the file is already open, so the count keeps growing.
	await source.locator('.lsp-token').first().click()
	await page.locator('.lsp-popover-location-link').first().click()
	await expect(viewers).toHaveCount(2, { timeout: LSP_TIMEOUT })

	await source.locator('.lsp-token').first().click()
	await page.locator('.lsp-popover-location-link').first().click()
	await expect(viewers).toHaveCount(3)

	// A connector is drawn for each opened window.
	await expect(page.locator('.connections-overlay .connection-line')).toHaveCount(2)
})
