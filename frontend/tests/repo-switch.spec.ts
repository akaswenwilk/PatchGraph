import { expect, test } from '@playwright/test'

test('switching repos updates the explorer tree without failing', async ({ page }) => {
	await page.goto('/')

	await page.getByRole('button', { name: 'Open Repo' }).click()
	const projectDialog = page.getByRole('dialog', { name: 'Open Repo' })
	await expect(projectDialog).toBeVisible()
	await projectDialog.getByRole('button', { name: /PatchGraph\s+PatchGraph$/ }).click()
	await projectDialog.getByRole('button', { name: 'Open', exact: true }).click()

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
