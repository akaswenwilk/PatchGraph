// Package lsp provides a minimal Language Server Protocol client used to gather
// definitions, references, and implementations for every symbol in a file.
//
// It speaks JSON-RPC 2.0 over a language server's stdio using only the standard
// library, and currently knows how to launch gopls (Go),
// typescript-language-server (TypeScript/JavaScript), and ruby-lsp (Ruby).
package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	// ErrUnsupportedLanguage is returned when no language server is configured
	// for a file's extension.
	ErrUnsupportedLanguage = errors.New("unsupported language for file")
	// ErrServerUnavailable is returned when the required language server binary
	// is not installed.
	ErrServerUnavailable = errors.New("language server not available")
)

// Position is a zero-based line/character offset within a document.
type Position struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

// Range spans a start and end position within a document.
type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

// Location identifies a range within a document. URI is the raw LSP file URI;
// Path is the project-relative path when the location falls inside the project,
// otherwise the absolute path (e.g. for standard library or dependency files).
//
// DefRange, when set, is the full extent (first through last line) of the
// declaration this location points at — e.g. a whole function/method/type body,
// not just its name. It is populated only for in-repo definition locations that
// resolve to a document symbol, so the UI can open just the definition's lines
// instead of the entire file. It is nil for things that aren't document symbols
// (local variables, parameters) and for references/implementations.
type Location struct {
	URI      string `json:"uri"`
	Path     string `json:"path"`
	Range    Range  `json:"range"`
	DefRange *Range `json:"defRange,omitempty"`
}

// SymbolInfo describes a single symbol referenced in the analyzed file along
// with the cross-references the language server reported for it. Occurrences
// lists every place the symbol appears within this file (so the same symbol's
// usages can all be marked), while Definitions/References/Implementations may
// point anywhere in the workspace.
type SymbolInfo struct {
	Name            string     `json:"name"`
	Kind            string     `json:"kind"`
	Position        Position   `json:"position"`
	Definitions     []Location `json:"definitions"`
	References      []Location `json:"references"`
	Implementations []Location `json:"implementations"`
	Occurrences     []Range    `json:"occurrences"`
}

// FileAnalysis is the full LSP result for a single file.
type FileAnalysis struct {
	File     string       `json:"file"`
	Language string       `json:"language"`
	Symbols  []SymbolInfo `json:"symbols"`
}

var tsServer = []string{"typescript-language-server", "--stdio"}

var rubyFilenames = map[string]struct{}{
	"capfile":   {},
	"gemfile":   {},
	"guardfile": {},
	"rakefile":  {},
}

// LanguageForFile maps a filename to the language server command and the LSP
// languageId to advertise. ok is false when the extension is unsupported.
func LanguageForFile(name string) (command []string, languageID string, ok bool) {
	base := strings.ToLower(filepath.Base(name))
	if _, ruby := rubyFilenames[base]; ruby {
		return []string{"ruby-lsp"}, "ruby", true
	}

	switch strings.ToLower(filepath.Ext(name)) {
	case ".go":
		return []string{"gopls", "serve"}, "go", true
	case ".rb", ".rake", ".gemspec", ".ru":
		return []string{"ruby-lsp"}, "ruby", true
	case ".ts", ".mts", ".cts":
		return tsServer, "typescript", true
	case ".tsx":
		return tsServer, "typescriptreact", true
	case ".js", ".mjs", ".cjs":
		return tsServer, "javascript", true
	case ".jsx":
		return tsServer, "javascriptreact", true
	default:
		return nil, "", false
	}
}

// maxAnalyzedTokens bounds how many identifier tokens a single file analysis
// will resolve, so a pathologically large file can't fan out into an unbounded
// number of language-server queries.
const maxAnalyzedTokens = 5000

// Analyze launches the language server, opens absFile, enumerates every
// identifier in it, and collects the definitions, references, and
// implementations for each distinct symbol — including symbols declared in
// other files or packages.
//
// root is the workspace/project root, absFile the absolute path to the file,
// languageID the LSP language identifier, and command the server invocation
// (typically from LanguageForFile).
func Analyze(ctx context.Context, root, absFile, languageID string, command []string) (FileAnalysis, error) {
	content, err := os.ReadFile(absFile)
	if err != nil {
		return FileAnalysis{}, err
	}
	lines := splitLines(string(content))

	c, err := startClient(ctx, command, root)
	if err != nil {
		return FileAnalysis{}, err
	}
	defer c.Close()

	legend, err := c.initialize(ctx, root)
	if err != nil {
		return FileAnalysis{}, fmt.Errorf("initialize: %w", err)
	}

	uri := pathToURI(absFile)
	if err := c.notify("textDocument/didOpen", map[string]any{
		"textDocument": map[string]any{
			"uri":        uri,
			"languageId": languageID,
			"version":    1,
			"text":       string(content),
		},
	}); err != nil {
		return FileAnalysis{}, fmt.Errorf("didOpen: %w", err)
	}
	c.docMu.Lock()
	c.openedDocs[uri] = true
	c.docMu.Unlock()

	// Prefer semantic tokens (covers every identifier, including cross-file
	// symbols); fall back to document symbols if the server has no token legend.
	var symbols []SymbolInfo
	if len(legend) > 0 {
		symbols, err = c.analyzeViaSemanticTokens(ctx, root, uri, lines, legend)
		if err != nil {
			return FileAnalysis{}, fmt.Errorf("semanticTokens: %w", err)
		}
	}
	if len(symbols) == 0 {
		symbols, err = c.analyzeViaDocumentSymbols(ctx, root, uri)
		if err != nil {
			return FileAnalysis{}, fmt.Errorf("documentSymbol: %w", err)
		}
	}

	return FileAnalysis{
		File:     relativePath(root, absFile),
		Language: languageID,
		Symbols:  symbols,
	}, nil
}

// analyzeViaSemanticTokens resolves every identifier token in the file. Tokens
// are grouped by the symbol they resolve to (via go-to-definition) so that
// references/implementations are fetched once per symbol, while every token's
// position is recorded as an occurrence to mark.
func (c *client) analyzeViaSemanticTokens(
	ctx context.Context,
	root, uri string,
	lines, legend []string,
) ([]SymbolInfo, error) {
	data, err := c.semanticTokens(ctx, uri)
	if err != nil {
		return nil, err
	}
	tokens := decodeSemanticTokens(data, legend)

	order := make([]string, 0)
	bySymbol := make(map[string]*SymbolInfo)
	resolved := 0

	for _, token := range tokens {
		if !identifierTokenTypes[token.Type] {
			continue
		}
		if resolved >= maxAnalyzedTokens {
			break
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		resolved++

		pos := Position{Line: token.Line, Character: token.Char}
		definitions := c.locations(ctx, "textDocument/definition", uri, pos)
		if len(definitions) == 0 {
			continue
		}

		occurrence := Range{
			Start: pos,
			End:   Position{Line: token.Line, Character: token.Char + token.Length},
		}
		key := definitions[0].URI + "#" +
			strconv.Itoa(definitions[0].Range.Start.Line) + ":" +
			strconv.Itoa(definitions[0].Range.Start.Character)

		if existing, ok := bySymbol[key]; ok {
			existing.Occurrences = append(existing.Occurrences, occurrence)
			continue
		}

		var implementations []Location
		if implementableTokenTypes[token.Type] {
			implementations = c.locations(ctx, "textDocument/implementation", uri, pos)
		}

		bySymbol[key] = &SymbolInfo{
			Name:            identifierText(lines, token),
			Kind:            kindFromTokenType(token.Type),
			Position:        pos,
			Definitions:     c.attachDefinitionRanges(ctx, root, keepInRepo(fillPaths(root, definitions))),
			References:      keepInRepo(fillPaths(root, c.references(ctx, uri, pos))),
			Implementations: keepInRepo(fillPaths(root, implementations)),
			Occurrences:     []Range{occurrence},
		}
		order = append(order, key)
	}

	symbols := make([]SymbolInfo, 0, len(order))
	for _, key := range order {
		symbols = append(symbols, *bySymbol[key])
	}
	return symbols, nil
}

// analyzeViaDocumentSymbols is the fallback used when the server exposes no
// semantic-token legend. It marks each declared symbol at its declaration.
func (c *client) analyzeViaDocumentSymbols(ctx context.Context, root, uri string) ([]SymbolInfo, error) {
	declared, err := c.documentSymbols(ctx, uri)
	if err != nil {
		return nil, err
	}

	symbols := make([]SymbolInfo, 0, len(declared))
	for _, sym := range declared {
		pos := sym.Position
		symbols = append(symbols, SymbolInfo{
			Name:            sym.Name,
			Kind:            symbolKindName(sym.Kind),
			Position:        pos,
			Definitions:     c.attachDefinitionRanges(ctx, root, keepInRepo(fillPaths(root, c.locations(ctx, "textDocument/definition", uri, pos)))),
			References:      keepInRepo(fillPaths(root, c.references(ctx, uri, pos))),
			Implementations: keepInRepo(fillPaths(root, c.locations(ctx, "textDocument/implementation", uri, pos))),
			Occurrences: []Range{{
				Start: pos,
				End:   Position{Line: pos.Line, Character: pos.Character + len(sym.Name)},
			}},
		})
	}
	return symbols, nil
}

// --- JSON-RPC client ---

type client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader

	writeMu sync.Mutex

	mu      sync.Mutex
	nextID  int64
	pending map[int]chan rpcResponse

	// Caches for definition-range enrichment, populated lazily as target files
	// are inspected. Analysis drives these sequentially, but docMu guards them
	// so the maps are safe regardless. openedDocs records which document URIs
	// have been didOpen'd; symbolRanges caches each file's document symbols with
	// their full and selection ranges.
	docMu        sync.Mutex
	openedDocs   map[string]bool
	symbolRanges map[string][]rangedSymbol

	done chan struct{}
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcNotification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResult struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
}

type rpcMessage struct {
	ID     *json.RawMessage `json:"id"`
	Method string           `json:"method"`
	Result json.RawMessage  `json:"result"`
	Params json.RawMessage  `json:"params"`
	Error  *rpcError        `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	result json.RawMessage
	err    error
}

func startClient(ctx context.Context, command []string, root string) (*client, error) {
	if len(command) == 0 {
		return nil, ErrServerUnavailable
	}
	if _, err := exec.LookPath(command[0]); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrServerUnavailable, command[0])
	}

	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = root
	cmd.Stderr = io.Discard

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	c := &client{
		cmd:          cmd,
		stdin:        stdin,
		stdout:       bufio.NewReader(stdout),
		pending:      make(map[int]chan rpcResponse),
		openedDocs:   make(map[string]bool),
		symbolRanges: make(map[string][]rangedSymbol),
		done:         make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

func (c *client) readLoop() {
	defer close(c.done)
	for {
		body, err := readMessage(c.stdout)
		if err != nil {
			c.failPending(err)
			return
		}

		var msg rpcMessage
		if err := json.Unmarshal(body, &msg); err != nil {
			continue
		}

		// Server-initiated request: must be answered or the server may block.
		if msg.Method != "" {
			if msg.ID != nil {
				c.handleServerRequest(msg)
			}
			continue
		}

		// Response to one of our requests.
		if msg.ID == nil {
			continue
		}
		var id int
		if err := json.Unmarshal(*msg.ID, &id); err != nil {
			continue
		}

		c.mu.Lock()
		ch := c.pending[id]
		c.mu.Unlock()
		if ch == nil {
			continue
		}
		if msg.Error != nil {
			ch <- rpcResponse{err: fmt.Errorf("lsp error %d: %s", msg.Error.Code, msg.Error.Message)}
		} else {
			ch <- rpcResponse{result: msg.Result}
		}
	}
}

// handleServerRequest answers server-to-client requests. We do not implement
// any real client capabilities, so we return empty/default results, which is
// enough to keep gopls, typescript-language-server, and ruby-lsp progressing.
func (c *client) handleServerRequest(msg rpcMessage) {
	var result any
	if msg.Method == "workspace/configuration" {
		var params struct {
			Items []json.RawMessage `json:"items"`
		}
		_ = json.Unmarshal(msg.Params, &params)
		result = make([]any, len(params.Items))
	}

	_ = c.write(rpcResult{JSONRPC: "2.0", ID: *msg.ID, Result: result})
}

func (c *client) failPending(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, ch := range c.pending {
		ch <- rpcResponse{err: err}
		delete(c.pending, id)
	}
}

func (c *client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := int(atomic.AddInt64(&c.nextID, 1))
	ch := make(chan rpcResponse, 1)

	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	if err := c.write(rpcRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params}); err != nil {
		return nil, err
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, errors.New("language server exited")
	case resp := <-ch:
		return resp.result, resp.err
	}
}

func (c *client) notify(method string, params any) error {
	return c.write(rpcNotification{JSONRPC: "2.0", Method: method, Params: params})
}

func (c *client) write(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := io.WriteString(c.stdin, fmt.Sprintf("Content-Length: %d\r\n\r\n", len(data))); err != nil {
		return err
	}
	_, err = c.stdin.Write(data)
	return err
}

func (c *client) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = c.call(ctx, "shutdown", nil)
	_ = c.notify("exit", nil)

	select {
	case <-c.done:
	case <-time.After(2 * time.Second):
		if c.cmd.Process != nil {
			_ = c.cmd.Process.Kill()
		}
	}
	return c.cmd.Wait()
}

// --- LSP request helpers ---

// standardTokenTypes is the set of semantic token types the client advertises
// support for. The server replies with its own legend (an ordered list whose
// indices the token data references), which we read from the initialize result.
var standardTokenTypes = []string{
	"namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
	"parameter", "variable", "property", "enumMember", "event", "function",
	"method", "member", "macro", "keyword", "modifier", "comment", "string",
	"number", "regexp", "operator", "decorator",
}

// initialize performs the LSP handshake and returns the server's semantic-token
// legend (token type names by index), which is empty if unsupported.
func (c *client) initialize(ctx context.Context, root string) ([]string, error) {
	params := map[string]any{
		"processId": os.Getpid(),
		"rootUri":   pathToURI(root),
		// gopls disables semantic tokens unless enabled via this setting.
		"initializationOptions": map[string]any{"semanticTokens": true},
		"capabilities": map[string]any{
			"textDocument": map[string]any{
				"documentSymbol": map[string]any{"hierarchicalDocumentSymbolSupport": true},
				"definition":     map[string]any{"linkSupport": true},
				"references":     map[string]any{},
				"implementation": map[string]any{"linkSupport": true},
				"semanticTokens": map[string]any{
					"requests":       map[string]any{"full": true},
					"tokenTypes":     standardTokenTypes,
					"tokenModifiers": []string{},
					"formats":        []string{"relative"},
				},
			},
			"workspace": map[string]any{"configuration": true},
		},
	}
	raw, err := c.call(ctx, "initialize", params)
	if err != nil {
		return nil, err
	}

	var result struct {
		Capabilities struct {
			SemanticTokensProvider json.RawMessage `json:"semanticTokensProvider"`
		} `json:"capabilities"`
	}
	_ = json.Unmarshal(raw, &result)
	legend := parseSemanticLegend(result.Capabilities.SemanticTokensProvider)

	if err := c.notify("initialized", map[string]any{}); err != nil {
		return nil, err
	}
	return legend, nil
}

func parseSemanticLegend(raw json.RawMessage) []string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" || trimmed == "false" {
		return nil
	}
	var provider struct {
		Legend struct {
			TokenTypes []string `json:"tokenTypes"`
		} `json:"legend"`
	}
	if err := json.Unmarshal(raw, &provider); err != nil {
		return nil
	}
	return provider.Legend.TokenTypes
}

func (c *client) semanticTokens(ctx context.Context, uri string) ([]uint32, error) {
	raw, err := c.call(ctx, "textDocument/semanticTokens/full", map[string]any{
		"textDocument": map[string]any{"uri": uri},
	})
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(raw)) == "null" {
		return nil, nil
	}

	var result struct {
		Data []uint32 `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	return result.Data, nil
}

func (c *client) documentSymbols(ctx context.Context, uri string) ([]flatSymbol, error) {
	raw, err := c.call(ctx, "textDocument/documentSymbol", map[string]any{
		"textDocument": map[string]any{"uri": uri},
	})
	if err != nil {
		return nil, err
	}

	var symbols []documentSymbol
	if err := json.Unmarshal(raw, &symbols); err != nil {
		return nil, err
	}

	var out []flatSymbol
	flattenSymbols(symbols, &out)
	return out, nil
}

// rangedSymbol is a flattened document symbol that keeps the full range (the
// whole declaration, including its body) and the selection range (just the
// name), used to map a definition position to the lines its declaration spans.
type rangedSymbol struct {
	Kind           int
	Range          Range
	SelectionRange Range
}

// definitionRangeKinds are the document-symbol kinds whose full range we treat
// as "the definition" worth opening on its own: functions, methods, types, and
// classes. Other kinds (variables, constants, fields, parameters) either aren't
// reported as document symbols or are single-line, so callers fall back to the
// definition's own line.
var definitionRangeKinds = map[int]bool{
	5:  true, // Class
	6:  true, // Method
	9:  true, // Constructor
	10: true, // Enum
	11: true, // Interface
	12: true, // Function
	23: true, // Struct
}

// attachDefinitionRanges fills DefRange on each in-repo definition location with
// the full extent of the document symbol it points at, when that symbol is a
// function/method/type/class. Locations that don't resolve to such a symbol are
// left with a nil DefRange. The input slice is mutated and returned.
func (c *client) attachDefinitionRanges(ctx context.Context, root string, definitions []Location) []Location {
	for i := range definitions {
		if r := c.definitionRange(ctx, root, definitions[i]); r != nil {
			definitions[i].DefRange = r
		}
	}
	return definitions
}

// definitionRange resolves the full line span of the declaration a definition
// location points at, or nil when the target isn't a qualifying document symbol
// (or can't be inspected). It opens the target file in the server as needed and
// caches its document symbols.
func (c *client) definitionRange(ctx context.Context, root string, def Location) *Range {
	// Only in-repo targets are openable; out-of-repo paths are absolute.
	if filepath.IsAbs(def.Path) {
		return nil
	}
	abs := filepath.Join(root, def.Path)
	if _, _, ok := LanguageForFile(abs); !ok {
		return nil
	}
	uri := pathToURI(abs)
	if err := c.openDocument(abs, uri); err != nil {
		return nil
	}
	symbols, err := c.documentSymbolsRanged(ctx, uri)
	if err != nil {
		return nil
	}
	return selectDefinitionRange(symbols, def.Range.Start)
}

// selectDefinitionRange returns the full range of the smallest qualifying
// document symbol whose name (selection range) covers pos, so a method is
// preferred over its enclosing type. Returns nil when nothing qualifies.
func selectDefinitionRange(symbols []rangedSymbol, pos Position) *Range {
	var best *rangedSymbol
	for i := range symbols {
		sym := symbols[i]
		if !definitionRangeKinds[sym.Kind] || !rangeContains(sym.SelectionRange, pos) {
			continue
		}
		if best == nil || rangeShorter(sym.Range, best.Range) {
			best = &symbols[i]
		}
	}
	if best == nil {
		return nil
	}
	span := best.Range
	return &span
}

// openDocument sends textDocument/didOpen for a target file if it hasn't been
// opened yet on this client, reading the file's current contents from disk.
func (c *client) openDocument(abs, uri string) error {
	c.docMu.Lock()
	already := c.openedDocs[uri]
	c.docMu.Unlock()
	if already {
		return nil
	}

	content, err := os.ReadFile(abs)
	if err != nil {
		return err
	}
	_, languageID, ok := LanguageForFile(abs)
	if !ok {
		return ErrUnsupportedLanguage
	}
	if err := c.notify("textDocument/didOpen", map[string]any{
		"textDocument": map[string]any{
			"uri":        uri,
			"languageId": languageID,
			"version":    1,
			"text":       string(content),
		},
	}); err != nil {
		return err
	}

	c.docMu.Lock()
	c.openedDocs[uri] = true
	c.docMu.Unlock()
	return nil
}

// documentSymbolsRanged returns a file's document symbols flattened with their
// full and selection ranges, cached per URI for the lifetime of the client.
func (c *client) documentSymbolsRanged(ctx context.Context, uri string) ([]rangedSymbol, error) {
	c.docMu.Lock()
	if cached, ok := c.symbolRanges[uri]; ok {
		c.docMu.Unlock()
		return cached, nil
	}
	c.docMu.Unlock()

	raw, err := c.call(ctx, "textDocument/documentSymbol", map[string]any{
		"textDocument": map[string]any{"uri": uri},
	})
	if err != nil {
		return nil, err
	}
	var symbols []documentSymbol
	if err := json.Unmarshal(raw, &symbols); err != nil {
		return nil, err
	}
	var out []rangedSymbol
	flattenRanged(symbols, &out)

	c.docMu.Lock()
	c.symbolRanges[uri] = out
	c.docMu.Unlock()
	return out, nil
}

// flattenRanged flattens the (possibly hierarchical) document-symbol tree into a
// list that preserves each symbol's kind and ranges. SymbolInformation-shaped
// results (no selectionRange, a location instead) are mapped onto both ranges.
func flattenRanged(symbols []documentSymbol, out *[]rangedSymbol) {
	for _, sym := range symbols {
		full := sym.Range
		selection := sym.SelectionRange
		if full == (Range{}) && sym.Location != nil {
			full = sym.Location.Range
		}
		if selection == (Range{}) {
			if sym.Location != nil {
				selection = sym.Location.Range
			} else {
				selection = full
			}
		}
		*out = append(*out, rangedSymbol{Kind: sym.Kind, Range: full, SelectionRange: selection})
		flattenRanged(sym.Children, out)
	}
}

// rangeContains reports whether pos lies within r (inclusive of both ends).
func rangeContains(r Range, pos Position) bool {
	if pos.Line < r.Start.Line || pos.Line > r.End.Line {
		return false
	}
	if pos.Line == r.Start.Line && pos.Character < r.Start.Character {
		return false
	}
	if pos.Line == r.End.Line && pos.Character > r.End.Character {
		return false
	}
	return true
}

// rangeShorter reports whether a spans fewer lines than b, breaking ties by the
// starting line so the most specific (innermost) symbol wins.
func rangeShorter(a, b Range) bool {
	aLines := a.End.Line - a.Start.Line
	bLines := b.End.Line - b.Start.Line
	if aLines != bLines {
		return aLines < bLines
	}
	return a.Start.Line > b.Start.Line
}

func (c *client) locations(ctx context.Context, method, uri string, pos Position) []Location {
	raw, err := c.call(ctx, method, textDocumentPositionParams(uri, pos))
	if err != nil {
		return nil
	}
	return parseLocations(raw)
}

func (c *client) references(ctx context.Context, uri string, pos Position) []Location {
	params := textDocumentPositionParams(uri, pos)
	params["context"] = map[string]any{"includeDeclaration": true}
	raw, err := c.call(ctx, "textDocument/references", params)
	if err != nil {
		return nil
	}
	return parseLocations(raw)
}

func textDocumentPositionParams(uri string, pos Position) map[string]any {
	return map[string]any{
		"textDocument": map[string]any{"uri": uri},
		"position":     map[string]any{"line": pos.Line, "character": pos.Character},
	}
}

// --- Semantic tokens ---

// identifierTokenTypes are the semantic token types we treat as nameable
// symbols worth resolving. Keywords, comments, strings, numbers, and operators
// are excluded.
var identifierTokenTypes = map[string]bool{
	"namespace": true, "type": true, "class": true, "enum": true,
	"interface": true, "struct": true, "typeParameter": true, "parameter": true,
	"variable": true, "property": true, "enumMember": true, "event": true,
	"function": true, "method": true, "member": true, "decorator": true,
	"macro": true,
}

// implementableTokenTypes are the token types for which asking for
// implementations is meaningful.
var implementableTokenTypes = map[string]bool{
	"type": true, "class": true, "interface": true, "struct": true, "method": true,
}

type semanticToken struct {
	Line   int
	Char   int
	Length int
	Type   string
}

// decodeSemanticTokens expands the LSP delta-encoded token stream (groups of 5
// integers: deltaLine, deltaStartChar, length, tokenType, tokenModifiers) into
// absolute-positioned tokens with their type name resolved via the legend.
func decodeSemanticTokens(data []uint32, legend []string) []semanticToken {
	tokens := make([]semanticToken, 0, len(data)/5)
	line, char := 0, 0

	for i := 0; i+4 < len(data); i += 5 {
		deltaLine := int(data[i])
		deltaStart := int(data[i+1])
		length := int(data[i+2])
		typeIndex := int(data[i+3])

		if deltaLine == 0 {
			char += deltaStart
		} else {
			line += deltaLine
			char = deltaStart
		}

		typeName := ""
		if typeIndex >= 0 && typeIndex < len(legend) {
			typeName = legend[typeIndex]
		}

		tokens = append(tokens, semanticToken{Line: line, Char: char, Length: length, Type: typeName})
	}

	return tokens
}

// identifierText returns the source text covered by a token, used as the
// symbol's display name.
func identifierText(lines []string, token semanticToken) string {
	if token.Line < 0 || token.Line >= len(lines) {
		return ""
	}
	line := lines[token.Line]
	start := token.Char
	end := token.Char + token.Length
	if start < 0 {
		start = 0
	}
	if end > len(line) {
		end = len(line)
	}
	if start >= end {
		return ""
	}
	return line[start:end]
}

func kindFromTokenType(tokenType string) string {
	if tokenType == "" {
		return "Symbol"
	}
	return strings.ToUpper(tokenType[:1]) + tokenType[1:]
}

func splitLines(text string) []string {
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	return lines
}

// --- Symbol handling ---

type flatSymbol struct {
	Name     string
	Kind     int
	Position Position
}

// documentSymbol unifies the two shapes the server may return for
// textDocument/documentSymbol: hierarchical DocumentSymbol (with
// selectionRange/children) and flat SymbolInformation (with location).
type documentSymbol struct {
	Name           string           `json:"name"`
	Kind           int              `json:"kind"`
	Range          Range            `json:"range"`
	SelectionRange Range            `json:"selectionRange"`
	Children       []documentSymbol `json:"children"`
	Location       *Location        `json:"location"`
}

func flattenSymbols(symbols []documentSymbol, out *[]flatSymbol) {
	for _, sym := range symbols {
		*out = append(*out, flatSymbol{
			Name:     sym.Name,
			Kind:     sym.Kind,
			Position: sym.queryPosition(),
		})
		flattenSymbols(sym.Children, out)
	}
}

// queryPosition returns the position to use when asking the server about a
// symbol, preferring the identifier's selection range.
func (s documentSymbol) queryPosition() Position {
	if s.SelectionRange != (Range{}) {
		return s.SelectionRange.Start
	}
	if s.Location != nil {
		return s.Location.Range.Start
	}
	return s.Range.Start
}

// parseLocations decodes a definition/references/implementation result, which
// may be a single Location, an array of Location, or an array of LocationLink.
func parseLocations(raw json.RawMessage) []Location {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}

	if strings.HasPrefix(trimmed, "[") {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil
		}
		out := make([]Location, 0, len(items))
		for _, item := range items {
			if loc, ok := parseOneLocation(item); ok {
				out = append(out, loc)
			}
		}
		return out
	}

	if loc, ok := parseOneLocation(raw); ok {
		return []Location{loc}
	}
	return nil
}

func parseOneLocation(raw json.RawMessage) (Location, bool) {
	var candidate struct {
		URI         string `json:"uri"`
		Range       Range  `json:"range"`
		TargetURI   string `json:"targetUri"`
		TargetRange Range  `json:"targetRange"`
	}
	if err := json.Unmarshal(raw, &candidate); err != nil {
		return Location{}, false
	}
	if candidate.URI != "" {
		return Location{URI: candidate.URI, Range: candidate.Range}, true
	}
	if candidate.TargetURI != "" {
		return Location{URI: candidate.TargetURI, Range: candidate.TargetRange}, true
	}
	return Location{}, false
}

func fillPaths(root string, locations []Location) []Location {
	for i := range locations {
		locations[i].Path = relativePath(root, uriToPath(locations[i].URI))
	}
	return locations
}

// keepInRepo drops locations that resolve outside the project. relativePath (in
// fillPaths) leaves the Path absolute when the file is outside root, so an
// absolute Path marks an out-of-repo location (standard library, dependencies).
func keepInRepo(locations []Location) []Location {
	kept := make([]Location, 0, len(locations))
	for _, location := range locations {
		if !filepath.IsAbs(location.Path) {
			kept = append(kept, location)
		}
	}
	return kept
}

// --- URI / path helpers ---

func pathToURI(path string) string {
	slashed := filepath.ToSlash(path)
	if !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	u := url.URL{Scheme: "file", Path: slashed}
	return u.String()
}

func uriToPath(uri string) string {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" {
		return uri
	}
	return filepath.FromSlash(u.Path)
}

func relativePath(root, abs string) string {
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return abs
	}
	return filepath.ToSlash(rel)
}

func readMessage(reader *bufio.Reader) ([]byte, error) {
	contentLength := -1
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if name, value, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return nil, fmt.Errorf("invalid Content-Length: %q", value)
			}
			contentLength = n
		}
	}
	if contentLength < 0 {
		return nil, errors.New("missing Content-Length header")
	}

	body := make([]byte, contentLength)
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil, err
	}
	return body, nil
}

// symbolKindName maps an LSP SymbolKind enum value to its name.
func symbolKindName(kind int) string {
	names := []string{
		"", "File", "Module", "Namespace", "Package", "Class", "Method",
		"Property", "Field", "Constructor", "Enum", "Interface", "Function",
		"Variable", "Constant", "String", "Number", "Boolean", "Array",
		"Object", "Key", "Null", "EnumMember", "Struct", "Event", "Operator",
		"TypeParameter",
	}
	if kind > 0 && kind < len(names) {
		return names[kind]
	}
	return "Unknown"
}
