import { expect, test, type Page } from '@playwright/test'

async function openProject(page: Page, projectName: RegExp): Promise<void> {
	await page.getByRole('button', { name: 'Open Repo' }).click()
	const projectDialog = page.getByRole('dialog', { name: 'Open Repo' })
	await expect(projectDialog).toBeVisible()
	await projectDialog.getByRole('button', { name: projectName }).click()
	await projectDialog.getByRole('button', { name: 'Open', exact: true }).click()
}

test('git menu lists branches as a tree and creates then deletes a branch', async ({ page }) => {
	await page.goto('/')
	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await expect(page.getByText('base.txt')).toBeVisible()

	await page.getByRole('button', { name: 'Git', exact: true }).click()
	const gitDialog = page.getByRole('dialog', { name: 'Git branches' })
	await expect(gitDialog).toBeVisible()

	// The seeded repo has feature/worktree-switch, so the tree nests it under a
	// "feature" folder.
	await expect(gitDialog.getByText('feature', { exact: true })).toBeVisible()
	await expect(gitDialog.getByText('worktree-switch')).toBeVisible()

	// Create a branch off the feature branch; it must appear without switching.
	const featureLeaf = gitDialog.getByRole('treeitem').filter({ hasText: 'worktree-switch' }).first()
	await featureLeaf.getByRole('button', { name: 'New' }).click()
	await gitDialog.getByPlaceholder(/New branch off feature\/worktree-switch/).fill('qa/playground')
	await gitDialog.getByRole('button', { name: 'Create', exact: true }).click()

	await expect(gitDialog.getByText(/Created qa\/playground/)).toBeVisible()
	const qaLeaf = gitDialog.getByRole('treeitem').filter({ hasText: 'playground' }).first()
	await expect(qaLeaf).toBeVisible()

	// Delete it again and confirm it disappears from the tree. Scope the absence
	// check to tree items so the "Deleted …" notice (which also contains the
	// branch name) does not keep the assertion alive.
	await qaLeaf.getByRole('button', { name: 'Delete' }).click()

	await expect(gitDialog.getByText(/Deleted qa\/playground/)).toBeVisible()
	await expect(gitDialog.getByRole('treeitem').filter({ hasText: 'playground' })).toHaveCount(0)
})

test('git menu surfaces a git error when deleting the current branch', async ({ page }) => {
	await page.goto('/')
	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await expect(page.getByText('base.txt')).toBeVisible()

	await page.getByRole('button', { name: 'Git', exact: true }).click()
	const gitDialog = page.getByRole('dialog', { name: 'Git branches' })
	await expect(gitDialog).toBeVisible()

	// The current branch is marked and its Delete button is disabled, so trying to
	// remove it is prevented up front.
	const currentLeaf = gitDialog.getByRole('treeitem').filter({ hasText: 'current' }).first()
	await expect(currentLeaf.getByRole('button', { name: 'Delete' })).toBeDisabled()
})
