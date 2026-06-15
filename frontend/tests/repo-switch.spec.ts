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
