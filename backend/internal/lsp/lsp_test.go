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
		{"app.rb", "ruby-lsp", "ruby", true},
		{"tasks/build.rake", "ruby-lsp", "ruby", true},
		{"patchgraph.gemspec", "ruby-lsp", "ruby", true},
		{"config.ru", "ruby-lsp", "ruby", true},
		{"Gemfile", "ruby-lsp", "ruby", true},
		{"Rakefile", "ruby-lsp", "ruby", true},
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

func TestFlattenRangedPreservesRanges(t *testing.T) {
	symbols := []documentSymbol{
		{
			Name:           "Greeter",
			Kind:           23, // Struct
			Range:          Range{Start: Position{5, 0}, End: Position{5, 21}},
			SelectionRange: Range{Start: Position{5, 5}, End: Position{5, 12}},
			Children: []documentSymbol{
				{
					Name:           "Greet",
					Kind:           6, // Method
					Range:          Range{Start: Position{8, 0}, End: Position{10, 1}},
					SelectionRange: Range{Start: Position{8, 17}, End: Position{8, 22}},
				},
			},
		},
	}
	var out []rangedSymbol
	flattenRanged(symbols, &out)

	want := []rangedSymbol{
		{Kind: 23, Range: Range{Start: Position{5, 0}, End: Position{5, 21}}, SelectionRange: Range{Start: Position{5, 5}, End: Position{5, 12}}},
		{Kind: 6, Range: Range{Start: Position{8, 0}, End: Position{10, 1}}, SelectionRange: Range{Start: Position{8, 17}, End: Position{8, 22}}},
	}
	if !reflect.DeepEqual(out, want) {
		t.Errorf("got %+v, want %+v", out, want)
	}
}

func TestFlattenRangedSymbolInformation(t *testing.T) {
	// SymbolInformation form: no range/selectionRange, both come from location.
	symbols := []documentSymbol{
		{
			Name:     "DoThing",
			Kind:     12,
			Location: &Location{URI: "file:///a.go", Range: Range{Start: Position{10, 4}, End: Position{12, 1}}},
		},
	}
	var out []rangedSymbol
	flattenRanged(symbols, &out)

	want := []rangedSymbol{{
		Kind:           12,
		Range:          Range{Start: Position{10, 4}, End: Position{12, 1}},
		SelectionRange: Range{Start: Position{10, 4}, End: Position{12, 1}},
	}}
	if !reflect.DeepEqual(out, want) {
		t.Errorf("got %+v, want %+v", out, want)
	}
}

func TestSelectDefinitionRange(t *testing.T) {
	greeter := rangedSymbol{
		Kind:           23, // Struct
		Range:          Range{Start: Position{5, 0}, End: Position{12, 1}},
		SelectionRange: Range{Start: Position{5, 5}, End: Position{5, 12}},
	}
	greet := rangedSymbol{
		Kind:           6, // Method (nested inside the struct's range)
		Range:          Range{Start: Position{8, 0}, End: Position{10, 1}},
		SelectionRange: Range{Start: Position{8, 17}, End: Position{8, 22}},
	}
	local := rangedSymbol{
		Kind:           13, // Variable — not a qualifying kind
		Range:          Range{Start: Position{9, 1}, End: Position{9, 10}},
		SelectionRange: Range{Start: Position{9, 1}, End: Position{9, 6}},
	}
	symbols := []rangedSymbol{greeter, greet, local}

	// A position on the method name resolves to the method's full body, not the
	// enclosing struct (innermost qualifying symbol wins).
	if got := selectDefinitionRange(symbols, Position{8, 18}); got == nil {
		t.Fatal("expected a range for the method name position")
	} else if *got != greet.Range {
		t.Errorf("method range = %+v, want %+v", *got, greet.Range)
	}

	// A position on the struct name resolves to the struct's range.
	if got := selectDefinitionRange(symbols, Position{5, 6}); got == nil {
		t.Fatal("expected a range for the struct name position")
	} else if *got != greeter.Range {
		t.Errorf("struct range = %+v, want %+v", *got, greeter.Range)
	}

	// A position on a non-qualifying (variable) symbol yields no range.
	if got := selectDefinitionRange(symbols, Position{9, 2}); got != nil {
		t.Errorf("variable position = %+v, want nil", *got)
	}

	// A position matching nothing yields no range.
	if got := selectDefinitionRange(symbols, Position{0, 0}); got != nil {
		t.Errorf("unmatched position = %+v, want nil", *got)
	}
}

func TestRangeContains(t *testing.T) {
	r := Range{Start: Position{2, 4}, End: Position{4, 6}}
	cases := []struct {
		pos  Position
		want bool
	}{
		{Position{3, 0}, true},  // interior line
		{Position{2, 4}, true},  // exact start
		{Position{4, 6}, true},  // exact end
		{Position{2, 3}, false}, // before start char on start line
		{Position{4, 7}, false}, // past end char on end line
		{Position{1, 9}, false}, // before start line
		{Position{5, 0}, false}, // after end line
	}
	for _, tc := range cases {
		if got := rangeContains(r, tc.pos); got != tc.want {
			t.Errorf("rangeContains(%+v) = %v, want %v", tc.pos, got, tc.want)
		}
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

import "fmt"

// Greeter greets.
type Greeter struct{}

// Greet returns a greeting.
func (g Greeter) Greet() string {
	return fmt.Sprintf("hi")
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

	greet := findSymbol(analysis.Symbols, func(s SymbolInfo) bool {
		return s.Name == "Greet" && s.Kind == "Method"
	})
	if greet == nil {
		t.Fatalf("Greet method not found in %v", symbolNames(analysis.Symbols))
	}
	// Greet is called from Use(), so it is marked at its declaration and the
	// call site: at least two occurrences in this file.
	if len(greet.Occurrences) < 2 {
		t.Errorf("Greet occurrences = %d, want >= 2", len(greet.Occurrences))
	}
	if len(greet.References) < 2 {
		t.Errorf("Greet references = %d, want >= 2", len(greet.References))
	}

	// Greet's definition carries the full extent of the method declaration: the
	// `func` line (index 8) through its closing brace (index 10), so the UI can
	// open just the definition instead of the whole file.
	if len(greet.Definitions) == 0 {
		t.Fatal("Greet has no definitions")
	}
	defRange := greet.Definitions[0].DefRange
	if defRange == nil {
		t.Fatal("Greet definition has no DefRange")
	}
	if defRange.Start.Line != 8 || defRange.End.Line != 10 {
		t.Errorf("Greet DefRange lines = %d..%d, want 8..10", defRange.Start.Line, defRange.End.Line)
	}

	// Out-of-repo locations are filtered out: every reported location is a
	// project-relative path, never an absolute one (stdlib/dependencies).
	for _, sym := range analysis.Symbols {
		for _, group := range [][]Location{sym.Definitions, sym.References, sym.Implementations} {
			for _, loc := range group {
				if filepath.IsAbs(loc.Path) {
					t.Errorf("symbol %q has out-of-repo location %q", sym.Name, loc.Path)
				}
			}
		}
	}

	// Sprintf is from the standard library: it is still resolved (so its in-repo
	// call site is marked), but its external definition has been filtered out.
	sprintf := findSymbol(analysis.Symbols, func(s SymbolInfo) bool {
		return s.Name == "Sprintf"
	})
	if sprintf == nil {
		t.Fatalf("Sprintf not found in %v", symbolNames(analysis.Symbols))
	}
	if len(sprintf.Definitions) != 0 {
		t.Errorf("Sprintf definitions = %d, want 0 (external definition filtered)", len(sprintf.Definitions))
	}
	if len(sprintf.References) == 0 {
		t.Error("Sprintf should keep its in-repo call-site reference")
	}
}

// TestAnalyzeWithRubyLSP is an end-to-end check that requires ruby-lsp to be
// installed. It is skipped on hosts without Ruby tooling.
func TestAnalyzeWithRubyLSP(t *testing.T) {
	if _, err := exec.LookPath("ruby-lsp"); err != nil {
		t.Skip("ruby-lsp not installed")
	}

	root := t.TempDir()
	source := `class Greeter
  def greet
    "hi"
  end
end

def use
  Greeter.new.greet
end
`
	absFile := filepath.Join(root, "sample.rb")
	writeTestFile(t, absFile, source)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	analysis, err := Analyze(ctx, root, absFile, "ruby", []string{"ruby-lsp"})
	if err != nil {
		t.Fatalf("Analyze() error = %v", err)
	}

	if analysis.File != "sample.rb" {
		t.Errorf("File = %q, want sample.rb", analysis.File)
	}
	if analysis.Language != "ruby" {
		t.Errorf("Language = %q, want ruby", analysis.Language)
	}
	if len(analysis.Symbols) == 0 {
		t.Fatal("expected at least one symbol")
	}
}

func findSymbol(symbols []SymbolInfo, match func(SymbolInfo) bool) *SymbolInfo {
	for i := range symbols {
		if match(symbols[i]) {
			return &symbols[i]
		}
	}
	return nil
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
