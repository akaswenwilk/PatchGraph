package lsp

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLanguageForFile(t *testing.T) {
	cases := []struct {
		name       string
		wantServer string
		wantLangID string
		wantOK     bool
	}{
		{"main.go", "gopls", "go", true},
		{"app.ts", "typescript-language-server", "typescript", true},
		{"App.tsx", "typescript-language-server", "typescriptreact", true},
		{"util.mts", "typescript-language-server", "typescript", true},
		{"index.js", "typescript-language-server", "javascript", true},
		{"widget.jsx", "typescript-language-server", "javascriptreact", true},
		{"README.md", "", "", false},
		{"noext", "", "", false},
	}

	for _, tc := range cases {
		command, langID, ok := LanguageForFile(tc.name)
		if ok != tc.wantOK {
			t.Errorf("%s: ok = %v, want %v", tc.name, ok, tc.wantOK)
			continue
		}
		if !ok {
			continue
		}
		if command[0] != tc.wantServer {
			t.Errorf("%s: server = %q, want %q", tc.name, command[0], tc.wantServer)
		}
		if langID != tc.wantLangID {
			t.Errorf("%s: languageID = %q, want %q", tc.name, langID, tc.wantLangID)
		}
	}
}

func TestPathURIRoundTrip(t *testing.T) {
	cases := []string{
		"/home/akw/projects/PatchGraph/main.go",
		"/path/with space/file.ts",
		"/weird/na#me.go",
	}
	for _, path := range cases {
		got := uriToPath(pathToURI(path))
		if got != path {
			t.Errorf("round trip %q = %q", path, got)
		}
	}
}

func TestPathToURIHasFileScheme(t *testing.T) {
	if uri := pathToURI("/a/b.go"); !strings.HasPrefix(uri, "file:///") {
		t.Errorf("uri = %q, want file:/// prefix", uri)
	}
}

func TestRelativePath(t *testing.T) {
	root := "/home/akw/projects/PatchGraph"
	if got := relativePath(root, root+"/internal/lsp/lsp.go"); got != "internal/lsp/lsp.go" {
		t.Errorf("relativePath inside = %q", got)
	}
	// Outside the root keeps the absolute path (e.g. stdlib/deps).
	if got := relativePath(root, "/usr/lib/go/src/fmt/print.go"); got != "/usr/lib/go/src/fmt/print.go" {
		t.Errorf("relativePath outside = %q", got)
	}
}

func TestParseLocationsSingle(t *testing.T) {
	got := parseLocations([]byte(`{"uri":"file:///a.go","range":{"start":{"line":1,"character":2},"end":{"line":1,"character":5}}}`))
	want := []Location{{URI: "file:///a.go", Range: Range{Start: Position{1, 2}, End: Position{1, 5}}}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestParseLocationsArray(t *testing.T) {
	got := parseLocations([]byte(`[{"uri":"file:///a.go","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}},{"uri":"file:///b.go","range":{"start":{"line":3,"character":0},"end":{"line":3,"character":4}}}]`))
	if len(got) != 2 || got[0].URI != "file:///a.go" || got[1].URI != "file:///b.go" {
		t.Errorf("got %+v", got)
	}
}

func TestParseLocationsLocationLink(t *testing.T) {
	got := parseLocations([]byte(`[{"targetUri":"file:///t.go","targetRange":{"start":{"line":7,"character":1},"end":{"line":7,"character":9}}}]`))
	want := []Location{{URI: "file:///t.go", Range: Range{Start: Position{7, 1}, End: Position{7, 9}}}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestParseLocationsNull(t *testing.T) {
	if got := parseLocations([]byte(`null`)); got != nil {
		t.Errorf("got %+v, want nil", got)
	}
	if got := parseLocations(nil); got != nil {
		t.Errorf("got %+v, want nil", got)
	}
}

func TestFlattenSymbolsHierarchical(t *testing.T) {
	symbols := []documentSymbol{
		{
			Name:           "Server",
			Kind:           23, // Struct
			SelectionRange: Range{Start: Position{2, 5}},
			Children: []documentSymbol{
				{Name: "Start", Kind: 6, SelectionRange: Range{Start: Position{3, 8}}},
			},
		},
	}
	var out []flatSymbol
	flattenSymbols(symbols, &out)

	want := []flatSymbol{
		{Name: "Server", Kind: 23, Position: Position{2, 5}},
		{Name: "Start", Kind: 6, Position: Position{3, 8}},
	}
	if !reflect.DeepEqual(out, want) {
		t.Errorf("got %+v, want %+v", out, want)
	}
}

func TestFlattenSymbolsInformation(t *testing.T) {
	// SymbolInformation form: no selectionRange, position comes from location.
	symbols := []documentSymbol{
		{
			Name:     "DoThing",
			Kind:     12,
			Location: &Location{URI: "file:///a.go", Range: Range{Start: Position{10, 4}}},
		},
	}
	var out []flatSymbol
	flattenSymbols(symbols, &out)

	if len(out) != 1 || out[0].Position != (Position{10, 4}) {
		t.Errorf("got %+v", out)
	}
}

func TestSymbolKindName(t *testing.T) {
	if got := symbolKindName(12); got != "Function" {
		t.Errorf("kind 12 = %q, want Function", got)
	}
	if got := symbolKindName(23); got != "Struct" {
		t.Errorf("kind 23 = %q, want Struct", got)
	}
	if got := symbolKindName(999); got != "Unknown" {
		t.Errorf("kind 999 = %q, want Unknown", got)
	}
}

func TestReadMessage(t *testing.T) {
	raw := "Content-Length: 17\r\nContent-Type: x\r\n\r\n{\"jsonrpc\":\"2.0\"}"
	body, err := readMessage(bufio.NewReader(strings.NewReader(raw)))
	if err != nil {
		t.Fatalf("readMessage() error = %v", err)
	}
	if string(body) != `{"jsonrpc":"2.0"}` {
		t.Errorf("body = %q", string(body))
	}
}

func TestReadMessageMissingHeader(t *testing.T) {
	if _, err := readMessage(bufio.NewReader(strings.NewReader("\r\nbody"))); err == nil {
		t.Error("expected error for missing Content-Length")
	}
}

// TestAnalyzeWithGopls is an end-to-end check that requires gopls to be
// installed. It is skipped otherwise (e.g. on a developer host without gopls).
func TestAnalyzeWithGopls(t *testing.T) {
	if _, err := exec.LookPath("gopls"); err != nil {
		t.Skip("gopls not installed")
	}

	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "go.mod"), "module example.com/sample\n\ngo 1.24\n")
	source := `package sample

// Greeter greets.
type Greeter struct{}

// Greet returns a greeting.
func (g Greeter) Greet() string {
	return "hi"
}

func Use() string {
	g := Greeter{}
	return g.Greet()
}
`
	absFile := filepath.Join(root, "sample.go")
	writeTestFile(t, absFile, source)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	analysis, err := Analyze(ctx, root, absFile, "go", []string{"gopls", "serve"})
	if err != nil {
		t.Fatalf("Analyze() error = %v", err)
	}

	if analysis.File != "sample.go" {
		t.Errorf("File = %q, want sample.go", analysis.File)
	}
	if len(analysis.Symbols) == 0 {
		t.Fatal("expected at least one symbol")
	}

	// gopls names the method "(Greeter).Greet"; match on the Greet method
	// regardless of the exact qualified form.
	var greet *SymbolInfo
	for i := range analysis.Symbols {
		if strings.Contains(analysis.Symbols[i].Name, "Greet") && analysis.Symbols[i].Kind == "Method" {
			greet = &analysis.Symbols[i]
			break
		}
	}
	if greet == nil {
		t.Fatalf("Greet method not found in %v", symbolNames(analysis.Symbols))
	}
	// Greet is called from Use(), so it should have at least its declaration
	// plus the call site among references.
	if len(greet.References) < 2 {
		t.Errorf("Greet references = %d, want >= 2", len(greet.References))
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll error = %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile error = %v", err)
	}
}

func symbolNames(symbols []SymbolInfo) []string {
	out := make([]string, 0, len(symbols))
	for _, s := range symbols {
		out = append(out, s.Name)
	}
	return out
}
