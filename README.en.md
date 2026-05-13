# CodeSense

[中文](README.md) | [English](README.en.md)

Config-driven code knowledge graph engine for Vue projects. Powered by tree-sitter AST parsing, LadybugDB graph database, MCP protocol, and Sigma.js visualization.

Inspired by [GitNexus](https://github.com/abhigyanpatwari/GitNexus), with enhancements focused on Vue semantics.

## Quick Start

```bash
# Initialize config
npx @code-sense/core init

# Interactive init (Vue / Electron-aware options)
npx @code-sense/core init --interactive

# Build knowledge graph index
npx @code-sense/core index

# Explore graph visualization
npx @code-sense/core view

# Run MCP server for AI coding agents
npx @code-sense/core serve
```

Install globally:

```bash
npm install -g @code-sense/core
code-sense init
```

## Core Capabilities

- Build graph nodes from `.vue` components, stores, routes, and more
- Build graph edges from imports, store usage, and route mappings
- Detect Vue framework API calls (such as `ref`, `computed`, `watch`)
- Provide MCP tools for impact analysis, call tracing, and semantic search
- Provide interactive browser visualization via Sigma.js

## Commands

| Command | Description |
| --- | --- |
| `index` | Build the knowledge graph |
| `view` | Start visualization server (default port `3456`) |
| `serve` | Start MCP server for AI agents |
| `init` | Scaffold a default `codesense.yaml` |
| `init --interactive` | Scaffold a fuller project config |

## MCP Tools

| Tool | What it does |
| --- | --- |
| `entity_context` | Full context for file/entity |
| `function_context` | Callers, callees, and sibling functions |
| `impact_analysis` | Change impact analysis |
| `diff_impact` | Git diff based impact tracing |
| `route_map` | Route-to-component mapping |
| `trace_usage` | Symbol usage trace with evidence |
| `find_entrypoints` | Identify entry points (routes, pages, etc.) |
| `semantic_search` | Semantic search for functions/snippets |
| `project_overview` | Graph-level project stats |
| `cypher` | Raw Cypher queries for debugging |

## MCP Config Example (Claude Code / Codex)

```json
{
  "mcpServers": {
    "code-sense": {
      "command": "npx",
      "args": ["@code-sense/core", "serve"]
    }
  }
}
```

Do not hardcode absolute paths in MCP config, or multiple projects may connect to the same graph data directory.

## License

MIT
