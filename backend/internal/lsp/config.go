package lsp

import (
	"errors"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

const ConfigEnvVar = "PATCHGRAPH_CONFIG"

// Config holds PatchGraph's language-server configuration. LanguageServers is
// keyed by PatchGraph's language keys: go, ruby, typescript, and javascript.
type Config struct {
	LanguageServers map[string]ServerConfig `yaml:"languageServers"`
}

type ServerConfig struct {
	Command               []string       `yaml:"command"`
	InitializationOptions map[string]any `yaml:"initializationOptions"`
	Settings              map[string]any `yaml:"settings"`
}

func DefaultConfig() Config {
	return Config{LanguageServers: map[string]ServerConfig{
		"go": {
			Command:               []string{"gopls", "serve"},
			InitializationOptions: map[string]any{"semanticTokens": true},
		},
		"ruby": {
			Command: []string{"ruby-lsp"},
		},
		"typescript": {
			Command: []string{"typescript-language-server", "--stdio"},
		},
		"javascript": {
			Command: []string{"typescript-language-server", "--stdio"},
		},
	}}
}

func LoadConfig(path string) (Config, error) {
	config := DefaultConfig()
	configPath := path
	if configPath == "" {
		configPath = defaultConfigPath()
	}
	if configPath == "" {
		return config, nil
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		if path == "" && errors.Is(err, os.ErrNotExist) {
			return config, nil
		}
		return Config{}, err
	}

	var override Config
	if err := yaml.Unmarshal(data, &override); err != nil {
		return Config{}, err
	}
	return mergeConfig(config, override), nil
}

func defaultConfigPath() string {
	if path := os.Getenv(ConfigEnvVar); path != "" {
		return path
	}
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return ""
		}
		configHome = filepath.Join(home, ".config")
	}
	return filepath.Join(configHome, "patchgraph", "config.yaml")
}

func mergeConfig(base Config, override Config) Config {
	merged := Config{LanguageServers: make(map[string]ServerConfig, len(base.LanguageServers))}
	for language, server := range base.LanguageServers {
		merged.LanguageServers[language] = server.clone()
	}
	for language, server := range override.LanguageServers {
		current := merged.LanguageServers[language].clone()
		if len(server.Command) > 0 {
			current.Command = append([]string(nil), server.Command...)
		}
		current.InitializationOptions = mergeMap(current.InitializationOptions, server.InitializationOptions)
		current.Settings = mergeMap(current.Settings, server.Settings)
		merged.LanguageServers[language] = current
	}
	return merged
}

func (s ServerConfig) clone() ServerConfig {
	return ServerConfig{
		Command:               append([]string(nil), s.Command...),
		InitializationOptions: cloneMap(s.InitializationOptions),
		Settings:              cloneMap(s.Settings),
	}
}

func mergeMap(base map[string]any, override map[string]any) map[string]any {
	if len(base) == 0 && len(override) == 0 {
		return nil
	}
	merged := cloneMap(base)
	if merged == nil {
		merged = map[string]any{}
	}
	for key, value := range override {
		baseNested, baseOK := merged[key].(map[string]any)
		overrideNested, overrideOK := value.(map[string]any)
		if baseOK && overrideOK {
			merged[key] = mergeMap(baseNested, overrideNested)
			continue
		}
		merged[key] = cloneValue(value)
	}
	return merged
}

func cloneMap(source map[string]any) map[string]any {
	if len(source) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = cloneValue(value)
	}
	return cloned
}

func cloneValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneMap(typed)
	case []any:
		cloned := make([]any, len(typed))
		for index, item := range typed {
			cloned[index] = cloneValue(item)
		}
		return cloned
	default:
		return typed
	}
}

func (c Config) serverForLanguage(languageKey string) ServerConfig {
	if c.LanguageServers == nil {
		c = DefaultConfig()
	}
	return c.LanguageServers[languageKey].clone()
}

func (s ServerConfig) configurationForSection(section string) any {
	if section == "" {
		return s.Settings
	}
	if s.Settings == nil {
		return nil
	}
	return s.Settings[section]
}
