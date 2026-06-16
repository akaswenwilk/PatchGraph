import {
	bundledLanguages,
	createHighlighter,
	type BundledLanguage,
	type Highlighter,
} from 'shiki'

// Single dark theme chosen to sit on top of the existing dark window chrome. We
// only consume per-token foreground colors (see codeToTokens below) so the
// window's own background shows through and stays visually consistent.
export const HIGHLIGHT_THEME = 'github-dark'

// File extension -> Shiki bundled language. Anything unmapped, or whose grammar
// fails to load, falls back to plain uncolored text.
const EXTENSION_LANGUAGE: Record<string, BundledLanguage> = {
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	tsx: 'tsx',
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	jsx: 'jsx',
	go: 'go',
	rs: 'rust',
	py: 'python',
	rb: 'ruby',
	java: 'java',
	kt: 'kotlin',
	kts: 'kotlin',
	scala: 'scala',
	swift: 'swift',
	c: 'c',
	h: 'c',
	cpp: 'cpp',
	cc: 'cpp',
	cxx: 'cpp',
	hpp: 'cpp',
	hh: 'cpp',
	cs: 'csharp',
	php: 'php',
	ex: 'elixir',
	exs: 'elixir',
	clj: 'clojure',
	lua: 'lua',
	dart: 'dart',
	r: 'r',
	json: 'json',
	jsonc: 'jsonc',
	yaml: 'yaml',
	yml: 'yaml',
	toml: 'toml',
	xml: 'xml',
	html: 'html',
	css: 'css',
	scss: 'scss',
	less: 'less',
	md: 'markdown',
	mdx: 'mdx',
	sh: 'bash',
	bash: 'bash',
	zsh: 'bash',
	fish: 'fish',
	sql: 'sql',
	graphql: 'graphql',
	gql: 'graphql',
	vue: 'vue',
	svelte: 'svelte',
	proto: 'proto',
	tf: 'terraform',
	hcl: 'hcl',
}

// Files identified by name rather than extension.
const FILENAME_LANGUAGE: Record<string, BundledLanguage> = {
	dockerfile: 'docker',
	makefile: 'make',
	'.gitignore': 'git-commit',
}

export function languageForFilename(filename: string): BundledLanguage | null {
	const base = filename.split('/').pop()?.toLowerCase() ?? ''

	const byName = FILENAME_LANGUAGE[base]
	if (byName) {
		return byName
	}

	const dot = base.lastIndexOf('.')
	if (dot <= 0) {
		return null
	}

	const lang = EXTENSION_LANGUAGE[base.slice(dot + 1)]
	// Guard against typos here ever drifting from Shiki's actual bundle.
	return lang && lang in bundledLanguages ? lang : null
}

let highlighterPromise: Promise<Highlighter> | null = null
const loadedLanguages = new Set<BundledLanguage>()

// Created once, lazily. Languages are loaded on demand so the initial bundle
// stays small instead of shipping every grammar up front.
function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: [HIGHLIGHT_THEME],
			langs: [],
		})
	}
	return highlighterPromise
}

export type HighlightedToken = {
	content: string
	color?: string
}

// Highlights the WHOLE file (not the diff fragment) and returns tokens grouped
// per line, so the caller can keep its own line-number gutter. The token line
// count matches the input line count (both split on "\n").
export async function highlightToLines(
	code: string,
	lang: BundledLanguage,
): Promise<HighlightedToken[][]> {
	const highlighter = await getHighlighter()

	if (!loadedLanguages.has(lang)) {
		await highlighter.loadLanguage(lang)
		loadedLanguages.add(lang)
	}

	const { tokens } = highlighter.codeToTokens(code, {
		lang,
		theme: HIGHLIGHT_THEME,
	})

	return tokens.map((line) =>
		line.map((token) => ({ content: token.content, color: token.color })),
	)
}
