# CodeSense

Config-driven code knowledge graph engine for Vue projects. Powered by tree-sitter AST parsing, LadybugDB graph database, MCP protocol, and Sigma.js WebGL visualization.

Inspired by [GitNexus](https://github.com/abhigyanpatwari/GitNexus), focused specifically on Vue framework semantics.

## Quick Start

```bash
# Initialize config for your project
npx @code-sense/core init

# Or answer a few questions to generate a Vue/Electron-aware config
npx @code-sense/core init --interactive

# Index your codebase
npx @code-sense/core index

# Explore the graph visually
npx @code-sense/core view

# Or connect via MCP to AI coding agents
npx @code-sense/core serve
```

Or install globally:

```bash
npm install -g @code-sense/core
code-sense init
```

## How It Works

CodeSense parses your Vue project into a **knowledge graph**:

```
┌─────────────┐     uses_store      ┌──────────┐
│  App.vue    │ ───────────────────→ │ user.ts  │
│  component  │ ←─── imports ────── │  store    │
└─────────────┘                      └──────────┘
                                           │
                                     has_item
                                           │
                               ┌───────────┴───────────┐
                               │  StoreItem: fetchUser  │
                               │  StoreItem: isLoggedIn │
                               └───────────────────────┘
```

Every `.vue` component, store file, and route definition becomes a node. Import statements, store usage, and route mappings become edges. Framework API calls (ref, computed, watch, etc.) are tracked as well.

## Configuration

Everything is driven by `codesense.yaml`:

```yaml
project:
  name: 'my-app'
  source_root: 'src'

entities:
  component:
    patterns: ['**/*.vue']
  store:
    patterns:
      - 'src/store/**/*.ts'
      - 'src/stores/**/*.ts'
  route:
    patterns:
      - 'src/router/**/*.ts'

framework_apis:
  - name: 'vue'
    sources: ['vue']
    api_list: ['ref', 'computed', 'watch', 'onMounted', ...]

relationships:
  uses_store:
    from: 'component'
    to: 'store'
    detect_by:
      - type: 'call_expression'
        pattern: 'use*Store' # Pinia
      - type: 'call_expression'
        pattern: 'mapState' # Vuex
      - type: 'call_expression'
        pattern: 'mapMutations'
      - type: 'member_expression'
        pattern: '$store.*'
```

Example configs for common scenarios:

- `codesense.legacy.yaml` — Vue 2.7 + vue-demi + Vuex/Pinia mix
- `codesense.modern.yaml` — Pure Vue 3 + Pinia + composables
- `codesense.test.yaml` — Test fixtures with both Pinia and Vuex patterns

## Commands

| Command              | Description                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `index`              | Build the knowledge graph                                                                       |
| `view`               | Start visualization server (default port 3456)                                                  |
| `serve`              | Run MCP server for AI agent integration                                                         |
| `init`               | Scaffold a default codesense.yaml                                                               |
| `init --interactive` | Scaffold a fuller config with Vue Router, stores, composables, mixins, and Electron IPC options |

## MCP Tools

| Tool               | What it answers                                                                   |
| ------------------ | --------------------------------------------------------------------------------- |
| `entity_context`   | "What is this file?" — full Vue-aware context, store internals, defined functions |
| `function_context` | "Who calls this function?" — callers, callees, siblings with AST-level accuracy   |
| `impact_analysis`  | "If I change this file, what breaks?" — bidirectional BFS traversal               |
| `diff_impact`      | "What changed in this git diff?" — function-level change impact trace             |
| `route_map`        | "Which URL maps to which component?"                                              |
| `trace_usage`      | "Where is this symbol used?" — with detection evidence                            |
| `find_entrypoints` | "What are the app entry points?" — routes, pages, project metadata                |
| `semantic_search`  | "Find functions matching this description" — TF-IDF with code-aware tokenization  |
| `project_overview` | Entity/edge counts, store breakdown, framework API stats                          |
| `cypher`           | Raw Cypher query for debugging                                                    |

### MCP Resources

When connected, the AI agent automatically sees:

| Resource         | URI                    | Content                                     |
| ---------------- | ---------------------- | ------------------------------------------- |
| Project metadata | `code-sense://project` | Project name, source root, entity stats     |
| Graph schema     | `code-sense://schema`  | Entity types, relationships, framework APIs |

### Configuring MCP in Claude Code / Codex

Remove `-c` and `-o` flags so it auto-detects the current project:

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

Claude Code sets the working directory to your project root automatically. The server will find `codesense.yaml` and `.code-sense/graph/` from there.

> **Warning:** Don't hardcode absolute paths in the MCP config, or every project will connect to the same graph.

## Visualization

The graph viewer (`code-sense view`) renders an interactive knowledge graph in the browser:

- **ForceAtlas2 layout** — adaptive physics simulation for readable graphs
- **Node highlighting** — click a node to focus, dimming everything else
- **Edge toggles** — show/hide edges by relationship type
- **Search with pulse animation** — find files by name, path, or type
- **Glass-morphism UI** — dark theme with backdrop blur panels
- N-overlap cleanup for dense areas

## Architecture

```
src/
├── index.ts            CLI entry point (commander)
├── config/
│   ├── loader.ts       YAML config parsing
│   └── defaults.ts     Default settings
├── engine/
│   ├── ast-traverser.ts   tree-sitter JS/TS parser
│   ├── sfc-parser.ts      Vue SFC block splitter
│   ├── file-scanner.ts    Glob-based file discovery
│   └── detectors/         9 built-in AST detectors
├── graph/
│   ├── builder.ts      Main indexing pipeline
│   ├── schema.ts       LadybugDB schema creation
│   └── lbug.ts         LadybugDB wrapper
├── mcp/
│   ├── server.ts       MCP stdio server (7 tools)
│   └── tools.ts        Tool implementations
├── vis/
│   ├── server.ts       HTTP server + inline Sigma.js app
│   └── adapter.ts      LadybugDB → Sigma.js converter
└── types/
    ├── config.ts        Configuration types
    └── graph.ts         Runtime graph types
```

## Tech Stack

| Layer         | Technology                                    |
| ------------- | --------------------------------------------- |
| Parsing       | tree-sitter (web-tree-sitter + WASM grammars) |
| Graph DB      | LadybugDB (embedded Cypher graph database)    |
| Protocol      | MCP (Model Context Protocol over stdio)       |
| Visualization | Sigma.js v3 + graphology (WebGL/Canvas)       |
| CLI           | commander + zod validation                    |

## License

MIT
