# CodeSense

Config-driven code knowledge graph engine for Vue projects. Powered by tree-sitter AST parsing, LadybugDB graph database, MCP protocol, and Sigma.js WebGL visualization.

Inspired by [GitNexus](https://github.com/abhigyanpatwari/GitNexus), focused specifically on Vue framework semantics.

## Quick Start

```bash
# Initialize config for your project
npx codesense init

# Index your codebase
npx codesense index

# Explore the graph visually
npx codesense view

# Or connect via MCP to AI coding agents
npx codesense serve
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
  name: "my-app"
  source_root: "src"

entities:
  component:
    patterns: ["**/*.vue"]
  store:
    patterns:
      - "src/store/**/*.ts"
      - "src/stores/**/*.ts"
  route:
    patterns:
      - "src/router/**/*.ts"

framework_apis:
  - name: "vue"
    sources: ["vue"]
    api_list: ["ref", "computed", "watch", "onMounted", ...]

relationships:
  uses_store:
    from: "component"
    to: "store"
    detect_by:
      - type: "call_expression"
        pattern: "use*Store"       # Pinia
      - type: "call_expression"
        pattern: "mapState"        # Vuex
      - type: "call_expression"
        pattern: "mapMutations"
      - type: "member_expression"
        pattern: "$store.*"
```

Example configs for common scenarios:
- `codesense.legacy.yaml` — Vue 2.7 + vue-demi + Vuex/Pinia mix
- `codesense.modern.yaml` — Pure Vue 3 + Pinia + composables
- `codesense.test.yaml` — Test fixtures with both Pinia and Vuex patterns

## Commands

| Command | Description |
|---------|-------------|
| `index` | Build the knowledge graph |
| `view`  | Start visualization server (default port 3456) |
| `serve` | Run MCP server for AI agent integration |
| `init`  | Scaffold a default codesense.yaml |

## MCP Tools

| Tool | What it answers |
|------|----------------|
| `entity_context` | Full Vue-aware context of any file: type, properties, store internals, relationships |
| `impact_analysis` | "If I change this file, what breaks?" — bidirectional BFS traversal |
| `route_map` | "Which URL maps to which component?" |
| `trace_usage` | "Where is this symbol used?" — with detection evidence |
| `find_entrypoints` | "What are the app entry points?" — routes, pages, project metadata |
| `project_overview` | Entity/edge counts, store breakdown, framework API stats |
| `cypher` | Raw Cypher query for debugging |

### Configuring MCP in Claude Code / Codex

```json
{
  "mcpServers": {
    "codesense": {
      "command": "node",
      "args": ["path/to/dist/index.js", "serve", "-c", "codesense.yaml"]
    }
  }
}
```

## Visualization

The graph viewer (`codesense view`) renders an interactive knowledge graph in the browser:

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

| Layer | Technology |
|-------|-----------|
| Parsing | tree-sitter (web-tree-sitter + WASM grammars) |
| Graph DB | LadybugDB (embedded Cypher graph database) |
| Protocol | MCP (Model Context Protocol over stdio) |
| Visualization | Sigma.js v3 + graphology (WebGL/Canvas) |
| CLI | commander + zod validation |

## License

MIT
