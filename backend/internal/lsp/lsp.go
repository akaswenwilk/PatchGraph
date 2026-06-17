// Package lsp provides a minimal Language Server Protocol client used to gather
// definitions, references, and implementations for every symbol in a file.
//
// It speaks JSON-RPC 2.0 over a language server's stdio using only the standard
// library, and currently knows how to launch gopls (Go) and
// typescript-language-server (TypeScript/JavaScript).
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
type Location struct {
	URI   string `json:"uri"`
	Path  string `json:"path"`
	Range Range  `json:"range"`
}

// SymbolInfo describes a single symbol declared in the analyzed file along with
// the cross-references the language server reported for it.
type SymbolInfo struct {
	Name            string     `json:"name"`
	Kind            string     `json:"kind"`
	Position        Position   `json:"position"`
	Definitions     []Location `json:"definitions"`
	References      []Location `json:"references"`
	Implementations []Location `json:"implementations"`
}

// FileAnalysis is the full LSP result for a single file.
type FileAnalysis struct {
	File     string       `json:"file"`
	Language string       `json:"language"`
	Symbols  []SymbolInfo `json:"symbols"`
}

var tsServer = []string{"typescript-language-server", "--stdio"}

// LanguageForFile maps a filename to the language server command and the LSP
// languageId to advertise. ok is false when the extension is unsupported.
func LanguageForFile(name string) (command []string, languageID string, ok bool) {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".go":
		return []string{"gopls", "serve"}, "go", true
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

// Analyze launches the language server, opens absFile, enumerates its symbols,
// and collects the definitions, references, and implementations for each.
//
// root is the workspace/project root, absFile the absolute path to the file,
// languageID the LSP language identifier, and command the server invocation
// (typically from LanguageForFile).
func Analyze(ctx context.Context, root, absFile, languageID string, command []string) (FileAnalysis, error) {
	content, err := os.ReadFile(absFile)
	if err != nil {
		return FileAnalysis{}, err
	}

	c, err := startClient(ctx, command, root)
	if err != nil {
		return FileAnalysis{}, err
	}
	defer c.Close()

	if err := c.initialize(ctx, root); err != nil {
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

	symbols, err := c.documentSymbols(ctx, uri)
	if err != nil {
		return FileAnalysis{}, fmt.Errorf("documentSymbol: %w", err)
	}

	analysis := FileAnalysis{
		File:     relativePath(root, absFile),
		Language: languageID,
		Symbols:  make([]SymbolInfo, 0, len(symbols)),
	}

	for _, sym := range symbols {
		info := SymbolInfo{
			Name:            sym.Name,
			Kind:            symbolKindName(sym.Kind),
			Position:        sym.Position,
			Definitions:     fillPaths(root, c.locations(ctx, "textDocument/definition", uri, sym.Position)),
			References:      fillPaths(root, c.references(ctx, uri, sym.Position)),
			Implementations: fillPaths(root, c.locations(ctx, "textDocument/implementation", uri, sym.Position)),
		}
		analysis.Symbols = append(analysis.Symbols, info)
	}

	return analysis, nil
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
		cmd:     cmd,
		stdin:   stdin,
		stdout:  bufio.NewReader(stdout),
		pending: make(map[int]chan rpcResponse),
		done:    make(chan struct{}),
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
// enough to keep gopls and typescript-language-server progressing.
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

func (c *client) initialize(ctx context.Context, root string) error {
	params := map[string]any{
		"processId": os.Getpid(),
		"rootUri":   pathToURI(root),
		"capabilities": map[string]any{
			"textDocument": map[string]any{
				"documentSymbol": map[string]any{"hierarchicalDocumentSymbolSupport": true},
				"definition":     map[string]any{"linkSupport": true},
				"references":     map[string]any{},
				"implementation": map[string]any{"linkSupport": true},
			},
			"workspace": map[string]any{"configuration": true},
		},
	}
	if _, err := c.call(ctx, "initialize", params); err != nil {
		return err
	}
	return c.notify("initialized", map[string]any{})
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
