import { resolve } from 'node:path';
import { LbugGraph } from '../graph/lbug.js';
import type { ResolvedConfig } from '../types/config.js';

export interface ToolContext {
  graph: LbugGraph;
  config: ResolvedConfig;
  dbPath: string;
}

export async function entityContext(
  ctx: ToolContext,
  params: { filePath: string },
): Promise<string> {
  const filePath = resolve(process.cwd(), params.filePath);

  const rows = await ctx.graph.query(
    `MATCH (n:Entity {filePath: '${escapeStr(filePath)}'}) RETURN n`,
  );

  if (rows.length === 0) {
    return `No entity found for path: ${filePath}`;
  }

  const n = (rows[0] as Record<string, unknown>).n as Record<string, unknown>;

  const parts: string[] = [];
  parts.push(`## Entity: ${n.name ?? filePath}`);
  parts.push(`- Type: ${n.entityType ?? 'unknown'}`);
  parts.push(`- Path: ${filePath}`);

  // Parse dynamic properties from JSON blob
  if (n.properties && typeof n.properties === 'string') {
    try {
      const props = JSON.parse(n.properties as string) as Record<string, unknown>;
      for (const [key, value] of Object.entries(props)) {
        if (key.startsWith('_')) continue; // internal properties
        parts.push(`- ${key}: ${JSON.stringify(value)}`);
      }
    } catch {
      parts.push(`- properties: ${n.properties}`);
    }
  }

  // Get outgoing relations
  const outgoing = await ctx.graph.query(
    `MATCH (n:Entity {filePath: '${escapeStr(filePath)}'})-[r]->(m:Entity) RETURN r, m.name as targetName, m.filePath as targetPath`,
  );
  if (outgoing.length > 0) {
    parts.push('\n### Outgoing Relations');
    for (const row of outgoing) {
      const r = row as Record<string, unknown>;
      const rel = r.r as Record<string, unknown> | undefined;
      parts.push(`- [${rel?._label ?? '?'}] → ${r.targetName ?? r.targetPath}`);
    }
  }

  // Get incoming relations
  const incoming = await ctx.graph.query(
    `MATCH (m:Entity)-[r]->(n:Entity {filePath: '${escapeStr(filePath)}'}) RETURN r, m.name as sourceName, m.filePath as sourcePath`,
  );
  if (incoming.length > 0) {
    parts.push('\n### Incoming Relations');
    for (const row of incoming) {
      const r = row as Record<string, unknown>;
      const rel = r.r as Record<string, unknown> | undefined;
      parts.push(`- [${rel?._label ?? '?'}] ← ${r.sourceName ?? r.sourcePath}`);
    }
  }

  return parts.join('\n');
}

export async function impactAnalysis(
  ctx: ToolContext,
  params: { filePath: string; depth?: number },
): Promise<string> {
  const filePath = resolve(process.cwd(), params.filePath);
  const maxDepth = Math.min(params.depth ?? 3, 5);

  const visited = new Set<string>();
  const queue: { path: string; depth: number; relationPath: string[] }[] = [
    { path: filePath, depth: 0, relationPath: [] },
  ];
  const impacts: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);

    if (current.depth > 0) {
      impacts.push(
        `${'  '.repeat(current.depth - 1)}↳ ${current.path} [${current.relationPath.join(' → ')}]`,
      );
    }

    if (current.depth >= maxDepth) continue;

    const outRows = await ctx.graph.query(
      `MATCH (n:Entity {filePath: '${escapeStr(current.path)}'})-[r]->(m:Entity) RETURN r, m.filePath as targetPath`,
    );

    for (const row of outRows) {
      const r = row as Record<string, unknown>;
      const rel = r.r as Record<string, unknown> | undefined;
      const targetPath = r.targetPath as string;
      if (!visited.has(targetPath)) {
        queue.push({
          path: targetPath,
          depth: current.depth + 1,
          relationPath: [...current.relationPath, (rel?._label as string) ?? '?'],
        });
      }
    }
  }

  if (impacts.length === 0) {
    return `No impacted entities found for: ${filePath} (within depth ${maxDepth})`;
  }

  return `## Impact Analysis: ${filePath}\nDepth: ${maxDepth}\n\n${impacts.join('\n')}`;
}

export async function cypher(
  ctx: ToolContext,
  params: { query: string },
): Promise<string> {
  try {
    const rows = await ctx.graph.query(params.query);
    return JSON.stringify(rows, null, 2);
  } catch (err) {
    return `Cypher error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function projectOverview(ctx: ToolContext): Promise<string> {
  const config = ctx.config;
  const parts: string[] = ['## Project Overview'];

  try {
    const countRows = await ctx.graph.query(
      `MATCH (n:Entity) RETURN count(n) as count`,
    );
    const totalNodes = (countRows[0] as Record<string, unknown>).count as number;
    parts.push(`Total entities: ${totalNodes}`);
  } catch {
    parts.push('Total entities: N/A (graph not indexed)');
  }

  // Count by entity type
  for (const entityType of Object.keys(config.all_entities)) {
    try {
      const rows = await ctx.graph.query(
        `MATCH (n:Entity {entityType: '${escapeStr(entityType)}'}) RETURN count(n) as count`,
      );
      const count = (rows[0] as Record<string, unknown>).count as number;
      parts.push(`- ${entityType}: ${count}`);
    } catch {
      // no data yet
    }
  }

  // Count total edges (all relationship types including auto-detected)
  let totalEdges = 0;
  try {
    const edgeRows = await ctx.graph.query(
      `MATCH ()-[r]->() RETURN count(r) as count`,
    );
    totalEdges = (edgeRows[0] as Record<string, unknown>).count as number;
  } catch {
    // no edges
  }
  parts.unshift(`Total edges: ${totalEdges}`);

  if (config.framework_apis?.length) {
    parts.push(
      `\nFramework APIs: ${config.framework_apis.map((a) => a.name).join(', ')}`,
    );
  }

  return parts.join('\n');
}

function escapeStr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
