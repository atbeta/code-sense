import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { dirname } from 'node:path';
import { LbugGraph } from '../graph/lbug.js';
import { loadConfig, resolveSourceRoot } from '../config/loader.js';
import {
  entityContext,
  impactAnalysis,
  cypher,
  projectOverview,
  routeMap,
  traceUsage,
  findEntrypoints,
  functionContext,
  diffImpact,
  semanticSearch,
} from './tools.js';
import type { ToolContext } from './tools.js';

export async function startMCPServer(
  configPath: string,
  dbPath: string,
  port?: number,
): Promise<void> {
  const config = loadConfig(configPath);
  const configDir = dirname(configPath) || process.cwd();
  const sourceRoot = resolveSourceRoot(config, configDir);

  const graph = new LbugGraph(dbPath);

  const ctx: ToolContext = { graph, config, dbPath };

  const server = new McpServer({
    name: 'code-sense',
    version: '0.1.0',
  });

  // ── Resources: project metadata visible on connection ──

  server.resource(
    'project',
    'code-sense://project',
    {
      description: 'Current project metadata — name, source root, entity types, graph stats.',
    },
    async () => {
      const overview = await projectOverview(ctx);
      return { contents: [{ text: overview, uri: 'code-sense://project' }] };
    },
  );

  server.resource(
    'schema',
    'code-sense://schema',
    {
      description: 'Graph schema — entity types, relationship types, and their descriptions.',
    },
    async () => {
      const entities = Object.entries(ctx.config.all_entities).map(
        ([name, def]) => `- **${name}**: ${def.description ?? '—'}`,
      );
      const rels = Object.entries(ctx.config.relationships ?? {}).map(
        ([name, def]) => `- **${name}** (${def.from} → ${def.to}): ${def.description ?? '—'}`,
      );
      const text = [
        `# CodeSense Graph Schema`,
        `Project: ${ctx.config.project.name}`,
        `Source root: ${ctx.config.project.source_root}`,
        '',
        '## Entity Types',
        ...entities,
        '',
        '## Relationships',
        ...rels,
        '',
        `## Framework APIs`,
        ...(ctx.config.framework_apis ?? []).map(
          (fw) =>
            `- **${fw.name}**: ${fw.api_list.length} APIs (sources: ${fw.sources.join(', ')})`,
        ),
      ].join('\n');
      return { contents: [{ text, uri: 'code-sense://schema' }] };
    },
  );

  // === entity_context ===
  server.registerTool(
    'entity_context',
    {
      description:
        'Get the full Vue-aware context of a code entity: its type (component/store/route/composable), properties (API mode, store variant, framework usage), store internals (state/getters/actions/mutations), and all incoming/outgoing relationships with evidence.',
      inputSchema: z.object({
        filePath: z
          .string()
          .describe(
            'The file path of the entity (absolute or relative to current working directory)',
          ),
      }),
    },
    async ({ filePath }) => {
      const result = await entityContext(ctx, { filePath });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // === impact_analysis ===
  server.registerTool(
    'impact_analysis',
    {
      description:
        'Analyze the blast radius of a change. Starting from a file, BFS-traverse outgoing relations to find all directly and transitively impacted entities. Answers: "If I change this file, what else might break?"',
      inputSchema: z.object({
        filePath: z
          .string()
          .describe('The file path of the entity to analyze as the epicenter of change'),
        depth: z.number().optional().describe('Maximum BFS traversal depth (default: 3, max: 5)'),
      }),
    },
    async ({ filePath, depth }) => {
      const result = await impactAnalysis(ctx, { filePath, depth });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // === route_map ===
  server.registerTool(
    'route_map',
    {
      description:
        'Map Vue Router route definitions to their target page components. Shows route paths, names, and which component/lazy-import they resolve to. Optionally filter by route pattern. Use limit to avoid large outputs (default 50).',
      inputSchema: z.object({
        routePattern: z
          .string()
          .optional()
          .describe(
            'Optional filter: route path pattern, component name, or route file name to search for',
          ),
        limit: z
          .number()
          .optional()
          .describe('Max route entries to return (default: 50, max: 200)'),
      }),
    },
    async ({ routePattern, limit }) => {
      const result = await routeMap(ctx, { routePattern, limit });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // === trace_usage ===
  server.registerTool(
    'trace_usage',
    {
      description:
        'Trace where a named symbol (store item, composable function, framework API) is used across the project. Searches StoreItem table and entity properties for references, with evidence of HOW each reference was detected (import, call, composable usage, etc.)',
      inputSchema: z.object({
        symbolName: z
          .string()
          .describe(
            'The symbol name to trace, e.g. "userState", "useAuth", "mapState", "defineStore"',
          ),
      }),
    },
    async ({ symbolName }) => {
      const result = await traceUsage(ctx, { symbolName });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // === find_entrypoints ===
  server.registerTool(
    'find_entrypoints',
    {
      description:
        'Find all project entry points: route definitions (with paths and target components), page-level components (in views/ or pages/), and extracted framework info from package.json (Vue version, Pinia/Vuex presence, UI framework, etc.)',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await findEntrypoints(ctx);
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // === function_context ===
  server.registerTool(
    'function_context',
    {
      description:
        'Get detailed context for a function or method: its kind (function/method/store_action/composable_function), location, content, callers (who calls this), callees (what this calls), and sibling functions in the same entity. Use filePath to disambiguate when multiple functions share the same name.',
      inputSchema: z.object({
        name: z
          .string()
          .describe('The function/method name to look up, e.g. "handleSubmit", "login", "useAuth"'),
        filePath: z
          .string()
          .optional()
          .describe('Optional file path to disambiguate functions with the same name across files'),
      }),
    },
    async ({ name, filePath }) => {
      const result = await functionContext(ctx, { name, filePath });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // === diff_impact ===
  server.registerTool(
    'diff_impact',
    {
      description:
        'Analyze the impact of your git changes. Given a file path or diff content, identifies which functions were changed, then traces CALLS edges to find downstream impacted functions. Essential for PR review and CI safety checks. Can accept a file path (runs git diff automatically) or raw diff content.',
      inputSchema: z.object({
        filePath: z
          .string()
          .optional()
          .describe(
            'Optional file path to diff against baseRef. If omitted, diffs the entire working tree.',
          ),
        diffContent: z
          .string()
          .optional()
          .describe(
            'Optional raw git diff content. Use this to pass a pre-computed diff instead of running git.',
          ),
        baseRef: z
          .string()
          .optional()
          .describe(
            'Git reference to diff against (default: HEAD). e.g. "main", "origin/main", "HEAD~1"',
          ),
      }),
    },
    async ({ filePath, diffContent, baseRef }) => {
      const result = await diffImpact(ctx, { filePath, diffContent, baseRef });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // === semantic_search ===
  server.registerTool(
    'semantic_search',
    {
      description:
        'Search for functions, methods, and entities using natural language or keywords. Uses TF-IDF with code-aware tokenization (camelCase, snake_case, PascalCase splitting) and name boosting. Answers: "find the login handler", "where is the auth validation logic?", "search for composables that deal with dark mode".',
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'Natural language search query, e.g. "login handler", "auth validation", "dark mode toggle"',
          ),
        limit: z.number().optional().describe('Maximum results to return (default: 15, max: 30)'),
        kind: z
          .string()
          .optional()
          .describe(
            'Optional filter by kind: function, method, composable_function, store_action, component, store, composable',
          ),
      }),
    },
    async ({ query, limit, kind }) => {
      const result = await semanticSearch(ctx, { query, limit, kind });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // === cypher (debug) ===
  server.registerTool(
    'cypher',
    {
      description:
        'Execute a raw Cypher query against the code knowledge graph. Use this for debugging or custom graph traversals not covered by the specialized tools.',
      inputSchema: z.object({
        query: z.string().describe('The Cypher query to execute against LadybugDB'),
      }),
    },
    async ({ query }) => {
      const result = await cypher(ctx, { query });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // === project_overview ===
  server.registerTool(
    'project_overview',
    {
      description:
        'Get a comprehensive project overview: entity counts by type, relationship counts by type, store internals breakdown, framework API usage stats, and project metadata from package.json.',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await projectOverview(ctx);
      return { content: [{ type: 'text', text: result }] };
    },
  );

  if (port) {
    // Streamable HTTP mode — for Continue, Claude Desktop, etc.
    const app = createMcpExpressApp();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await server.connect(transport);

    app.post('/mcp', async (req: Request, res: Response) => {
      await transport.handleRequest(req, res, req.body);
    });
    app.get('/mcp', async (req: Request, res: Response) => {
      await transport.handleRequest(req, res);
    });
    app.delete('/mcp', async (req: Request, res: Response) => {
      await transport.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => {
      app.listen(port, () => {
        console.error(`[CodeSense] MCP server listening on http://localhost:${port}/mcp`);
        console.error(`[CodeSense] 10 tools available`);
        console.error(`[CodeSense] Config: ${configPath}`);
        console.error(`[CodeSense] Graph DB: ${dbPath}`);
        console.error(`[CodeSense] Source root: ${sourceRoot}`);
        resolve();
      });
    });
  } else {
    // Stdio mode
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[CodeSense] MCP server started — 10 tools available`);
    console.error(`[CodeSense] Config: ${configPath}`);
    console.error(`[CodeSense] Graph DB: ${dbPath}`);
    console.error(`[CodeSense] Source root: ${sourceRoot}`);
  }
}
