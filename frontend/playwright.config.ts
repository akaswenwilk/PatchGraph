import { defineConfig } from '@playwright/test'

export default defineConfig({
	testDir: './tests',
	timeout: 120_000,
	expect: {
		timeout: 15_000,
	},
	reporter: [['list'], ['html', { open: 'never' }]],
	use: {
		baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173',
		trace: 'on-first-retry',
	},
	projects: [
		{
			name: 'chromium',
			use: {
				browserName: 'chromium',
				viewport: { width: 1600, height: 1000 },
			},
		},
	],
})
