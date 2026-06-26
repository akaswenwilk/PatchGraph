import { expect, test, type Page } from '@playwright/test'

async function openProject(page: Page, projectName: RegExp): Promise<void> {
	await page.getByRole('button', { name: 'Open Repo' }).click()
	const projectDialog = page.getByRole('dialog', { name: 'Open Repo' })
	await expect(projectDialog).toBeVisible()
	await projectDialog.getByRole('button', { name: projectName }).click()
	await projectDialog.getByRole('button', { name: 'Open', exact: true }).click()
}

test('collapsing a window hides its body, then expanding restores its size and scroll', async ({
	page,
}) => {
	await page.goto('/')
	await openProject(page, /PatchGraph\s+PatchGraph$/)
	await page.getByRole('button', { name: /lib\.go/ }).click()

	const viewer = page.getByRole('region', { name: 'File viewer for lib.go' })
	const body = viewer.locator('.file-code-scroll')
	await expect(body).toBeVisible()

	// Shrink the window via the corner handle so its short body becomes scrollable.
	const corner = viewer.getByRole('button', { name: 'Resize lib.go', exact: true })
	const handle = await corner.boundingBox()
	if (!handle) {
		throw new Error('resize handle has no box')
	}
	await page.mouse.move(handle.x + 2, handle.y + 2)
	await page.mouse.down()
	await page.mouse.move(handle.x + 2 - 320, handle.y + 2 - 430, { steps: 8 })
	await page.mouse.up()

	// Scroll partway down and record the size + scroll to restore.
	await body.evaluate((el) => {
		el.scrollTop = 60
	})
	const scrollBefore = await body.evaluate((el) => el.scrollTop)
	expect(scrollBefore).toBeGreaterThan(0)
	const expandedBox = await viewer.boundingBox()
	if (!expandedBox) {
		throw new Error('viewer has no box')
	}

	// Collapse: the body is hidden and the window shrinks to just its header.
	await viewer.getByRole('button', { name: 'Collapse lib.go' }).click()
	await expect(body).toBeHidden()
	const collapsedBox = await viewer.boundingBox()
	expect(collapsedBox!.height).toBeLessThan(expandedBox.height)

	// Expand: the body returns at exactly the same size and scroll position.
	await viewer.getByRole('button', { name: 'Expand lib.go' }).click()
	await expect(body).toBeVisible()
	const restoredBox = await viewer.boundingBox()
	expect(Math.abs(restoredBox!.width - expandedBox.width)).toBeLessThan(1)
	expect(Math.abs(restoredBox!.height - expandedBox.height)).toBeLessThan(1)
	const scrollAfter = await body.evaluate((el) => el.scrollTop)
	expect(scrollAfter).toBe(scrollBefore)
})
