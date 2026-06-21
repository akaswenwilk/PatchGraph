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

	// The seeded repo is on `main` with `feature/worktree-switch` and `playground`.
	await expect(gitDialog.getByText('Current branch')).toBeVisible()
	await expect(gitDialog.locator('.git-current-branch')).toHaveText('main')
	await expect(gitDialog.getByText('feature/worktree-switch')).toBeVisible()
	await expect(gitDialog.getByText('playground', { exact: true })).toBeVisible()

	await gitDialog.getByRole('button', { name: 'Close', exact: true }).click()
	await expect(gitDialog).not.toBeVisible()
})

test('creating a branch switches to it and adds it to the list', async ({ page }) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: 'Git', exact: true }).click()

	const gitDialog = page.getByRole('dialog', { name: 'Git' })
	await expect(gitDialog).toBeVisible()
	await expect(gitDialog.locator('.git-current-branch')).toHaveText('main')

	await gitDialog.getByRole('button', { name: 'Create branch' }).click()
	await gitDialog.getByRole('textbox', { name: 'New branch name' }).fill('feature/scratch')
	await gitDialog.getByRole('button', { name: 'Create', exact: true }).click()

	// The new branch is created off main, becomes current, and joins the list.
	await expect(gitDialog.locator('.git-current-branch')).toHaveText('feature/scratch')
	await expect(
		gitDialog.locator('.git-branch-name', { hasText: 'feature/scratch' }),
	).toBeVisible()

	// Re-creating an existing branch surfaces the reason instead of switching.
	await gitDialog.getByRole('button', { name: 'Create branch' }).click()
	await gitDialog.getByRole('textbox', { name: 'New branch name' }).fill('main')
	await gitDialog.getByRole('button', { name: 'Create', exact: true }).click()
	await expect(gitDialog.getByText(/already exists/i)).toBeVisible()
	await expect(gitDialog.locator('.git-current-branch')).toHaveText('feature/scratch')
})

test('switching branches reloads windows, marks deleted files, and restores them', async ({
	page,
}) => {
	await page.goto('/')

	await openProject(page, /PatchGraph\s+PatchGraph$/)

	// Open a file that exists on every branch and one that exists only on main.
	await page.getByRole('button', { name: /base\.txt/ }).click()
	const baseViewer = page.getByRole('region', { name: 'File viewer for base.txt' })
	await expect(baseViewer).toBeVisible()

	await page.getByRole('button', { name: /only-on-main\.txt/ }).click()
	const onlyMainViewer = page.getByRole('region', { name: 'File viewer for only-on-main.txt' })
	await expect(onlyMainViewer).toBeVisible()
	await expect(onlyMainViewer.getByText('only on main')).toBeVisible()

	// Switch to playground, where only-on-main.txt does not exist.
	await page.getByRole('button', { name: 'Git', exact: true }).click()
	const gitDialog = page.getByRole('dialog', { name: 'Git' })
	await gitDialog.getByRole('button', { name: 'playground', exact: true }).click()

	// The current branch updates in place.
	await expect(gitDialog.locator('.git-current-branch')).toHaveText('playground')

	// The window for the now-missing file becomes a "(deleted)" placeholder…
	await expect(onlyMainViewer.getByText('(deleted)')).toBeVisible()
	await expect(
		onlyMainViewer.getByText('This file does not exist on the current branch.'),
	).toBeVisible()
	// …while a file present on both branches keeps its contents.
	await expect(baseViewer.getByText('base')).toBeVisible()

	// Switching back to main restores the deleted window's contents.
	await gitDialog.getByRole('button', { name: 'main', exact: true }).click()
	await expect(gitDialog.locator('.git-current-branch')).toHaveText('main')
	await expect(onlyMainViewer.getByText('(deleted)')).toHaveCount(0)
	await expect(onlyMainViewer.getByText('only on main')).toBeVisible()
})
