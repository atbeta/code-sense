import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { LbugGraph } from '../graph/lbug.js';
import { loadConfig, resolveSourceRoot } from '../config/loader.js';
import {
  entityContext,
  impactAnalysis,
  cypher,
  projectOverview,
} from './tools.js';
import type { ToolContext } from './tools.js';

export async function startMCPServer(
  configPath: string,
  dbPath: string,
): Promise<void> {
  const config = loadConfig(configPath);
  const sourceRoot = resolveSourceRoot(
    config,
    configPath.replace(/\/[^/]+$/, '') || process.cwd(),
  );

  const graph = new LbugGraph(dbPath);

  const ctx: ToolContext = { graph, config, dbPath };

  const server = new McpServer({
    name: 'codesense',
    version: '0.1.0',
  });

  server.registerTool(
    'entity_context',
    {
      description:
        'Get the full context of a code entity: its type, properties, and all incoming/outgoing relationships.',
      inputSchema: z.object({
        filePath: z
          .string()
          .describe('The file path of the entity (absolute or relative)'),
      }),
    },
    async ({ filePath }) => {
      const result = await entityContext(ctx, { filePath });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  server.registerTool(
    'impact_analysis',
    {
      description:
        'Analyze the blast radius of a change: starting from an entity, traverse the graph to find all impacted entities.',
      inputSchema: z.object({
        filePath: z
          .string()
          .describe('The file path of the entity to analyze'),
        depth: z
          .number()
          .optional()
          .describe('Maximum traversal depth (default: 3, max: 5)'),
      }),
    },
    async ({ filePath, depth }) => {
      const result = await impactAnalysis(ctx, { filePath, depth });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  server.registerTool(
    'cypher',
    {
      description:
        'Execute a raw Cypher query against the code knowledge graph.',
      inputSchema: z.object({
        query: z.string().describe('The Cypher query to execute'),
      }),
    },
    async ({ query }) => {
      const result = await cypher(ctx, { query });
      return { content: [{ type: 'text', text: result }] };
    },
  );

  server.registerTool(
    'project_overview',
    {
      description:
        'Get an overview of the indexed project: entity counts, relationship counts, and framework API configuration.',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await projectOverview(ctx);
      return { content: [{ type: 'text', text: result }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[CodeSense] MCP server started`);
  console.error(`[CodeSense] Config: ${configPath}`);
  console.error(`[CodeSense] Graph DB: ${dbPath}`);
  console.error(`[CodeSense] Source root: ${sourceRoot}`);
}
