import { expect, test, type Page } from '@playwright/test'

async function openProject(page: Page, projectName: RegExp): Promise<void> {
	await page.getByRole('button', { name: 'Open Repo' }).click()
	const projectDialog = page.getByRole('dialog', { name: 'Open Repo' })
	await expect(projectDialog).toBeVisible()
	await projectDialog.getByRole('button', { name: projectName }).click()
	await projectDialog.getByRole('button', { name: 'Open', exact: true }).click()
}

test('git button is hidden until a repo is opened', async ({ page }) => {
	await page.goto('/')

	await expect(page.getByRole('button', { name: 'Git', exact: true })).toHaveCount(0)

	await openProject(page, /PatchGraph\s+PatchGraph$/)

	await expect(page.getByRole('button', { name: 'Git', exact: true })).toBeVisible()
})

test('git menu shows the current branch and local branches', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: 'Git', exact: true }).click()

	const gitDialog = page.getByRole('dialog', { name: 'Git' })
	await expect(gitDialog).toBeVisible()

	// The seeded repo is on `main` with a `feature/worktree-switch` branch.
	await expect(gitDialog.getByText('Current branch')).toBeVisible()
	await expect(gitDialog.getByText('main', { exact: true })).toBeVisible()
	await expect(gitDialog.getByText('feature/worktree-switch')).toBeVisible()

	await gitDialog.getByRole('button', { name: 'Close', exact: true }).click()
	await expect(gitDialog).not.toBeVisible()
})
