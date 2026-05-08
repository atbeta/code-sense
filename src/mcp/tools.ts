import { resolve, relative, sep } from 'node:path';
import { LbugGraph } from '../graph/lbug.js';
import type { ResolvedConfig } from '../types/config.js';

export interface ToolContext {
  graph: LbugGraph;
  config: ResolvedConfig;
  dbPath: string;
}

// ===== entity_context =====

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
  const relPath = relative(process.cwd(), filePath) || filePath;
  parts.push(`## ${n.name ?? relPath}`);
  parts.push(`- **Type**: ${n.entityType ?? 'unknown'}`);
  parts.push(`- **Path**: ${relPath}`);

  // Parse dynamic properties
  let props: Record<string, unknown> = {};
  if (n.properties && typeof n.properties === 'string') {
    try {
      props = JSON.parse(n.properties as string) as Record<string, unknown>;
    } catch {
      // ignore
    }
  }

  // Show key properties first
  const priorityKeys = ['name', 'variant', 'apiMode', 'usesStore', 'usesComposables', 'isVue', 'isRouter'];
  const shown = new Set<string>();
  for (const key of priorityKeys) {
    if (props[key] !== undefined && !key.startsWith('_')) {
      parts.push(`- **${key}**: ${formatProp(props[key])}`);
      shown.add(key);
    }
  }

  // Then rest
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('_') || shown.has(key) || priorityKeys.includes(key)) continue;
    parts.push(`- **${key}**: ${formatProp(value)}`);
  }

  // Store internals
  const storeItems = await ctx.graph.query(
    `MATCH (n:Entity {filePath: '${escapeStr(filePath)}'})-[r:has_item]->(s:StoreItem) RETURN s.name as name, s.itemType as itemType`,
  );
  if (storeItems.length > 0) {
    const byType: Record<string, string[]> = {};
    for (const row of storeItems) {
      const r = row as Record<string, unknown>;
      const itemType = (r.itemType as string) || 'unknown';
      const name = r.name as string;
      (byType[itemType] ??= []).push(name);
    }
    parts.push('');
    parts.push('### Store Internals');
    for (const [itemType, names] of Object.entries(byType)) {
      parts.push(`- **${itemType}** (${names.length}): ${names.slice(0, 20).join(', ')}${names.length > 20 ? '...' : ''}`);
    }
  }

  // Functions/methods defined in this entity
  const funcRows = await ctx.graph.query(
    `MATCH (e:Entity {filePath: '${escapeStr(filePath)}'})-[:defines]->(f:Function) RETURN f.name as name, f.kind as kind, f.startLine as startLine, f.endLine as endLine ORDER BY f.startLine`,
  );
  if (funcRows.length > 0) {
    parts.push('');
    parts.push('### Functions & Methods');
    for (const row of funcRows) {
      const r = row as Record<string, unknown>;
      parts.push(`- \`${r.name}\` (${r.kind}) :${r.startLine}-${r.endLine}`);
    }
  }

  // Framework API usage
  const apiRows = await ctx.graph.query(
    `MATCH (n:Entity {filePath: '${escapeStr(filePath)}'})-[r:USES_API]->(fw:FrameworkAPI) RETURN fw.name as name, r.properties as edgeProps`,
  );
  if (apiRows.length > 0) {
    parts.push('');
    parts.push('### Framework API Usage');
    const apiNames = apiRows.map((r) => {
      const row = r as Record<string, unknown>;
      return row.name as string;
    });
    parts.push(apiNames.slice(0, 30).join(', ') + (apiNames.length > 30 ? `... (+${apiNames.length - 30} more)` : ''));
  }

  // Outgoing relations with evidence
  const outgoing = await ctx.graph.query(
    `MATCH (n:Entity {filePath: '${escapeStr(filePath)}'})-[r]->(m:Entity) RETURN r, m.name as targetName, m.filePath as targetPath, m.entityType as targetType`,
  );
  if (outgoing.length > 0) {
    parts.push('');
    parts.push('### Outgoing Relations');
    for (const row of outgoing) {
      const r = row as Record<string, unknown>;
      const rel = r.r as Record<string, unknown> | undefined;
      const relType = rel?._label ?? '?';
      const targetRel = relative(process.cwd(), (r.targetPath as string) || '');
      parts.push(`- \`${relType}\` → **${r.targetName ?? r.targetPath}** (${r.targetType ?? 'entity'}) \`${targetRel}\``);
    }
  }

  // Incoming relations
  const incoming = await ctx.graph.query(
    `MATCH (m:Entity)-[r]->(n:Entity {filePath: '${escapeStr(filePath)}'}) RETURN r, m.name as sourceName, m.filePath as sourcePath, m.entityType as sourceType`,
  );
  if (incoming.length > 0) {
    parts.push('');
    parts.push('### Incoming Relations');
    for (const row of incoming) {
      const r = row as Record<string, unknown>;
      const rel = r.r as Record<string, unknown> | undefined;
      const relType = rel?._label ?? '?';
      const sourceRel = relative(process.cwd(), (r.sourcePath as string) || '');
      parts.push(`- **${r.sourceName ?? r.sourcePath}** (${r.sourceType ?? 'entity'}) \`${sourceRel}\` → \`${relType}\``);
    }
  }

  return parts.join('\n');
}

// ===== impact_analysis =====

interface ImpactNode {
  path: string;
  relPath: string;
  entityType: string;
  depth: number;
  relationPath: string[];
}

export async function impactAnalysis(
  ctx: ToolContext,
  params: { filePath: string; depth?: number },
): Promise<string> {
  const filePath = resolve(process.cwd(), params.filePath);
  const maxDepth = Math.min(params.depth ?? 3, 5);

  const visited = new Set<string>();
  const impacts: ImpactNode[] = [];

  // Check entity exists
  const check = await ctx.graph.query(
    `MATCH (n:Entity {filePath: '${escapeStr(filePath)}'}) RETURN n`,
  );
  if (check.length === 0) {
    return `No entity found for path: ${relative(process.cwd(), filePath)}`;
  }

  async function bfs(startPath: string) {
    const queue: { path: string; depth: number; relationPath: string[] }[] = [
      { path: startPath, depth: 0, relationPath: [] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.path)) continue;
      visited.add(current.path);

      if (current.depth > 0) {
        impacts.push({
          path: current.path,
          relPath: relative(process.cwd(), current.path) || current.path,
          entityType: '',
          depth: current.depth,
          relationPath: current.relationPath,
        });
      }

      if (current.depth >= maxDepth) continue;

      // Follow outgoing edges
      const outRows = await ctx.graph.query(
        `MATCH (n:Entity {filePath: '${escapeStr(current.path)}'})-[r]->(m:Entity) RETURN r as rel, m.filePath as targetPath`,
      );
      for (const row of outRows) {
        const r = row as Record<string, unknown>;
        const rel = r.rel as Record<string, unknown> | undefined;
        const relType = (rel?._label as string) ?? '?';
        const targetPath = r.targetPath as string;
        if (!visited.has(targetPath)) {
          queue.push({
            path: targetPath,
            depth: current.depth + 1,
            relationPath: [...current.relationPath, relType],
          });
        }
      }

      // Also follow incoming edges (who depends on this?)
      const inRows = await ctx.graph.query(
        `MATCH (m:Entity)-[r]->(n:Entity {filePath: '${escapeStr(current.path)}'}) RETURN r as rel, m.filePath as sourcePath`,
      );
      for (const row of inRows) {
        const r = row as Record<string, unknown>;
        const rel = r.rel as Record<string, unknown> | undefined;
        const relType = (rel?._label as string) ?? '?';
        const sourcePath = r.sourcePath as string;
        if (!visited.has(sourcePath)) {
          queue.push({
            path: sourcePath,
            depth: current.depth + 1,
            relationPath: [...current.relationPath, '(in) ' + relType],
          });
        }
      }
    }
  }

  await bfs(filePath);

  if (impacts.length === 0) {
    return `## Impact Analysis: ${relative(process.cwd(), filePath)}\nNo impacted entities found within depth ${maxDepth}.`;
  }

  const byDepth = new Map<number, ImpactNode[]>();
  for (const imp of impacts) {
    const list = byDepth.get(imp.depth) ?? [];
    list.push(imp);
    byDepth.set(imp.depth, list);
  }

  const parts: string[] = [
    `## Impact Analysis: \`${relative(process.cwd(), filePath)}\``,
    `Depth: ${maxDepth} | Total impacted: ${impacts.length}`,
    '',
  ];

  for (let d = 1; d <= maxDepth; d++) {
    const level = byDepth.get(d);
    if (!level || level.length === 0) continue;
    parts.push(`### Depth ${d} (${level.length} entities)`);
    for (const imp of level) {
      const indent = '  '.repeat(d);
      parts.push(`${indent}- [${imp.relationPath[imp.relationPath.length - 1] || '?'}] → \`${imp.relPath}\``);
    }
  }

  return parts.join('\n');
}

// ===== route_map =====

export async function routeMap(
  ctx: ToolContext,
  params: { routePattern?: string },
): Promise<string> {
  const pattern = params.routePattern ?? '';

  let query: string;
  if (pattern) {
    query = `MATCH (n:Entity {entityType: 'route'})-[r]->(m:Entity) WHERE n.properties CONTAINS '${escapeStr(pattern)}' OR n.name = '${escapeStr(pattern)}' OR m.name CONTAINS '${escapeStr(pattern)}' RETURN n.filePath as routePath, n.name as routeName, n.properties as routeProps, r as rel, m.filePath as componentPath, m.name as componentName, m.properties as componentProps`;
  } else {
    query = `MATCH (n:Entity {entityType: 'route'})-[r]->(m:Entity) RETURN n.filePath as routePath, n.name as routeName, n.properties as routeProps, r as rel, m.filePath as componentPath, m.name as componentName, m.properties as componentProps`;
  }

  const rows = await ctx.graph.query(query);
  if (rows.length === 0) {
    return `No route-to-component mappings found${pattern ? ` matching '${pattern}'` : ''}. Ensure routes have been indexed and relationships configured.`;
  }

  const parts: string[] = ['## Route Map' + (pattern ? ` (matching "${pattern}")` : '')];
  parts.push(`Total mappings: ${rows.length}`);
  parts.push('');

  // Group by route file
  const byRoute = new Map<string, typeof rows>();
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const routePath = (r.routePath as string) || '';
    const list = byRoute.get(routePath) ?? [];
    list.push(row);
    byRoute.set(routePath, list);
  }

  for (const [routePath, entries] of byRoute) {
    const relRoute = relative(process.cwd(), routePath) || routePath;
    parts.push(`### \`${relRoute}\``);

    for (const row of entries) {
      const r = row as Record<string, unknown>;
      const routeProps = parseProps(r.routeProps);
      const rel = r.rel as Record<string, unknown> | undefined;
      const relType = (rel?._label as string) ?? '?';
      const compRel = relative(process.cwd(), (r.componentPath as string) || '') || '?';

      if (routeProps.routes && Array.isArray(routeProps.routes)) {
        for (const route of routeProps.routes as Array<Record<string, unknown>>) {
          parts.push(`- \`${route.path ?? '?'}\` (${route.name ?? 'unnamed'}) → **${r.componentName ?? compRel}** \`${compRel}\``);
        }
      } else {
        parts.push(`- \`${relType}\` → **${r.componentName ?? compRel}** \`${compRel}\``);
      }
    }
  }

  return parts.join('\n');
}

// ===== trace_usage =====

export async function traceUsage(
  ctx: ToolContext,
  params: { symbolName: string },
): Promise<string> {
  const name = params.symbolName;

  // Search in StoreItem
  const storeItemRows = await ctx.graph.query(
    `MATCH (s:StoreItem) WHERE s.name = '${escapeStr(name)}' RETURN s.name as name, s.itemType as itemType, s.storePath as storePath`,
  );

  // Search entities that reference this name in their properties
  const entityRows = await ctx.graph.query(
    `MATCH (n:Entity) WHERE n.properties CONTAINS '${escapeStr(name)}' RETURN n.name as name, n.filePath as filePath, n.entityType as entityType, n.properties as props`,
  );

  const parts: string[] = [`## Trace Usage: \`${name}\``];

  if (storeItemRows.length > 0) {
    parts.push('');
    parts.push('### As Store Item');
    for (const row of storeItemRows) {
      const r = row as Record<string, unknown>;
      const storeRel = relative(process.cwd(), (r.storePath as string) || '') || '';
      parts.push(`- ${r.itemType}: \`${r.name}\` in **${storeRel}**`);
    }
  }

  if (entityRows.length > 0) {
    parts.push('');
    parts.push('### Referenced In');
    for (const row of entityRows) {
      const r = row as Record<string, unknown>;
      const rel = relative(process.cwd(), (r.filePath as string) || '') || '';
      const entityType = r.entityType as string;
      const props = parseProps(r.props);

      // Check if the name appears in specific fields
      const evidence: string[] = [];
      if (props.frameworkApiImports && Array.isArray(props.frameworkApiImports)) {
        if ((props.frameworkApiImports as string[]).includes(name)) {
          evidence.push('imported as framework API');
        }
      }
      if (props.storeCalls && Array.isArray(props.storeCalls)) {
        if ((props.storeCalls as string[]).some((s: string) => s.includes(name))) {
          evidence.push('called as store function');
        }
      }
      if (props.composableCalls && Array.isArray(props.composableCalls)) {
        if ((props.composableCalls as string[]).includes(name)) {
          evidence.push('called as composable');
        }
      }

      if (evidence.length > 0) {
        parts.push(`- **${r.name ?? rel}** (${entityType}) \`${rel}\` — ${evidence.join(', ')}`);
      } else {
        parts.push(`- **${r.name ?? rel}** (${entityType}) \`${rel}\``);
      }
    }
  }

  if (storeItemRows.length === 0 && entityRows.length === 0) {
    parts.push('\nNo usages found.');
  }

  return parts.join('\n');
}

// ===== find_entrypoints =====

export async function findEntrypoints(ctx: ToolContext): Promise<string> {
  // Entrypoints = route entities + top-level page components
  const routeRows = await ctx.graph.query(
    `MATCH (n:Entity {entityType: 'route'}) RETURN n.filePath as filePath, n.name as name, n.properties as props`,
  );

  const parts: string[] = ['## Project Entrypoints'];

  if (routeRows.length > 0) {
    parts.push('');
    parts.push('### Route Files');
    for (const row of routeRows) {
      const r = row as Record<string, unknown>;
      const rel = relative(process.cwd(), (r.filePath as string) || '') || '';
      const props = parseProps(r.props);

      if (props.routes && Array.isArray(props.routes)) {
        parts.push(`- **${r.name ?? rel}** \`${rel}\` (${(props.routes as unknown[]).length} routes defined)`);
        for (const route of props.routes as Array<Record<string, unknown>>) {
          parts.push(`  - \`${route.path ?? '?'}\` → \`${route.component ?? '?'}\``);
        }
      } else {
        parts.push(`- **${r.name ?? rel}** \`${rel}\``);
      }
    }
  }

  // Find components that are entry points (e.g., App.vue, main pages)
  const componentRows = await ctx.graph.query(
    `MATCH (n:Entity {entityType: 'component'}) RETURN n.filePath as filePath, n.name as name, n.properties as props`,
  );

  const entryComponents = componentRows.filter((row) => {
    const r = row as Record<string, unknown>;
    const rel = relative(process.cwd(), (r.filePath as string) || '') || '';
    // Heuristic: components in views/, pages/, or named App.* are likely entry points
    return rel.includes(sep + 'views' + sep) || rel.includes(sep + 'pages' + sep) ||
      rel.toLowerCase().includes('app.vue') || rel.toLowerCase().includes('main');
  });

  if (entryComponents.length > 0) {
    parts.push('');
    parts.push('### Page Components');
    for (const row of entryComponents) {
      const r = row as Record<string, unknown>;
      const rel = relative(process.cwd(), (r.filePath as string) || '') || '';
      const props = parseProps(r.props);
      const apiMode = props.apiMode ? ` [${props.apiMode}]` : '';
      parts.push(`- **${r.name ?? rel}** \`${rel}\`${apiMode}`);
    }
  }

  // Framework information from package.json
  try {
    const pkgRows = await ctx.graph.query(
      `MATCH (n:Entity {entityType: 'package'}) RETURN n.properties as props`,
    );
    if (pkgRows.length > 0) {
      const r = pkgRows[0] as Record<string, unknown>;
      const props = parseProps(r.props);
      parts.push('');
      parts.push('### Project Info');
      if (props.name) parts.push(`- Name: ${props.name}`);
      if (props.vueVersion) parts.push(`- Vue: ${props.vueVersion}`);
      if (props.hasPinia) parts.push('- Pinia: yes');
      if (props.hasVuex) parts.push('- Vuex: yes');
      if (props.hasVueDemi) parts.push('- vue-demi: yes');
      if (props.frameworkDeps) {
        parts.push('- Dependencies: ' + JSON.stringify(props.frameworkDeps));
      }
    }
  } catch {
    // no package info
  }

  if (routeRows.length === 0 && entryComponents.length === 0) {
    parts.push('\nNo entrypoints found. Index the project first.');
  }

  return parts.join('\n');
}

// ===== cypher (debug tool) =====

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

// ===== project_overview =====

export async function projectOverview(ctx: ToolContext): Promise<string> {
  const config = ctx.config;
  const parts: string[] = [
    `## ${config.project.name} — Project Overview`,
    `Source root: ${config.project.source_root}`,
  ];

  // Total entities
  try {
    const countRows = await ctx.graph.query(`MATCH (n:Entity) RETURN count(n) as count`);
    const totalNodes = (countRows[0] as Record<string, unknown>).count as number;
    parts.push(`Total entities: ${totalNodes}`);
  } catch {
    parts.push('Total entities: N/A (graph not indexed)');
  }

  // Count by entity type
  parts.push('');
  parts.push('### Entities by Type');
  const allTypes = Object.keys(config.all_entities);
  allTypes.push('package'); // auto-added
  for (const entityType of allTypes) {
    try {
      const rows = await ctx.graph.query(
        `MATCH (n:Entity {entityType: '${escapeStr(entityType)}'}) RETURN count(n) as count`,
      );
      const count = (rows[0] as Record<string, unknown>).count as number;
      if (count > 0) {
        parts.push(`- ${entityType}: ${count}`);
      }
    } catch {
      // no data yet
    }
  }

  // Store internals
  try {
    const storeItemRows = await ctx.graph.query(
      `MATCH (s:StoreItem) RETURN s.itemType as itemType, count(s) as count`,
    );
    if (storeItemRows.length > 0) {
      parts.push('');
      parts.push('### Store Internals');
      for (const row of storeItemRows) {
        const r = row as Record<string, unknown>;
        parts.push(`- ${r.itemType}: ${r.count}`);
      }
    }
  } catch {
    // not yet indexed
  }

  // Total edges
  let totalEdges = 0;
  try {
    const edgeRows = await ctx.graph.query(`MATCH ()-[r]->() RETURN count(r) as count`);
    totalEdges = (edgeRows[0] as Record<string, unknown>).count as number;
  } catch {
    // no edges
  }
  parts.unshift(`Total edges: ${totalEdges}`);

  // Edge breakdown
  try {
    const edgeTypeRows = await ctx.graph.query(
      `MATCH ()-[r]->() RETURN r._label as label, count(r) as count`,
    );
    if (edgeTypeRows.length > 0) {
      parts.push('');
      parts.push('### Relations by Type');
      // Sort by count desc
      const sorted = [...edgeTypeRows].sort((a, b) => {
        const ac = (a as Record<string, unknown>).count as number;
        const bc = (b as Record<string, unknown>).count as number;
        return bc - ac;
      });
      for (const row of sorted) {
        const r = row as Record<string, unknown>;
        parts.push(`- ${r.label}: ${r.count}`);
      }
    }
  } catch {
    // ignore
  }

  // Framework API count
  if (config.framework_apis?.length) {
    parts.push('');
    parts.push('### Framework API Usage');
    for (const fw of config.framework_apis) {
      parts.push(`- ${fw.name}: ${fw.api_list.length} APIs tracked`);
    }
    try {
      const fwCount = await ctx.graph.query(`MATCH (n:FrameworkAPI) RETURN count(n) as count`);
      const count = (fwCount[0] as Record<string, unknown>).count as number;
      parts.push(`- APIs detected: ${count}`);
    } catch {
      // ignore
    }
  }

  return parts.join('\n');
}

// ===== function_context =====

export async function functionContext(
  ctx: ToolContext,
  params: { name: string; filePath?: string },
): Promise<string> {
  const name = params.name;
  const filePath = params.filePath;

  let query: string;
  if (filePath) {
    const resolved = resolve(process.cwd(), filePath);
    query = `MATCH (f:Function {name: '${escapeStr(name)}'}) WHERE f.filePath = '${escapeStr(resolved)}' RETURN f`;
  } else {
    query = `MATCH (f:Function {name: '${escapeStr(name)}'}) RETURN f`;
  }

  const rows = await ctx.graph.query(query);
  if (rows.length === 0) {
    return `No function found named \`${name}\`${filePath ? ' in ' + filePath : ''}.`;
  }

  // If multiple matches, show summary first then detail for first
  if (rows.length > 1 && !filePath) {
    const parts: string[] = [
      `## Function \`${name}\` (${rows.length} matches)`,
      '',
    ];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const f = r.f as Record<string, unknown>;
      const relPath = relative(process.cwd(), (f.filePath as string) || '');
      parts.push(`- \`${relPath}\` :${f.startLine} (${f.kind})`);
    }
    parts.push('');
    parts.push('Use `filePath` parameter to narrow down.');
    return parts.join('\n');
  }

  const f = (rows[0] as Record<string, unknown>).f as Record<string, unknown>;
  const fnId = f.id as string;
  const relPath = relative(process.cwd(), (f.filePath as string) || '');
  const parts: string[] = [
    `## \`${f.name}\` — Function Context`,
    `- **Kind**: ${f.kind}`,
    `- **File**: \`${relPath}\``,
    `- **Location**: :${f.startLine}–${f.endLine}`,
    `- **Content**:`,
    '```ts',
    (f.content as string) ?? '',
    '```',
  ];

  // Callers (incoming CALLS)
  const callers = await ctx.graph.query(
    `MATCH (caller:Function)-[r:CALLS]->(f:Function {id: '${escapeStr(fnId)}'}) RETURN caller.name as name, caller.filePath as filePath, caller.kind as kind, caller.startLine as startLine, r.confidence as confidence`,
  );
  if (callers.length > 0) {
    parts.push('');
    parts.push('### Called By (callers)');
    for (const row of callers) {
      const r = row as Record<string, unknown>;
      const cRel = relative(process.cwd(), (r.filePath as string) || '');
      parts.push(`- \`${r.name}\` (${r.kind}) in \`${cRel}\` :${r.startLine}`);
    }
  }

  // Callees (outgoing CALLS)
  const callees = await ctx.graph.query(
    `MATCH (f:Function {id: '${escapeStr(fnId)}'})-[r:CALLS]->(callee:Function) RETURN callee.name as name, callee.filePath as filePath, callee.kind as kind, callee.startLine as startLine`,
  );
  if (callees.length > 0) {
    parts.push('');
    parts.push('### Calls');
    for (const row of callees) {
      const r = row as Record<string, unknown>;
      const cRel = relative(process.cwd(), (r.filePath as string) || '');
      parts.push(`- → \`${r.name}\` (${r.kind}) in \`${cRel}\` :${r.startLine}`);
    }
  }

  // Sibling functions (same entity)
  const siblings = await ctx.graph.query(
    `MATCH (e:Entity)-[:defines]->(f:Function {id: '${escapeStr(fnId)}'}) MATCH (e)-[:defines]->(sibling:Function) WHERE sibling.id <> '${escapeStr(fnId)}' RETURN sibling.name as name, sibling.kind as kind, sibling.startLine as startLine`,
  );
  if (siblings.length > 0) {
    parts.push('');
    parts.push('### Sibling Functions');
    for (const row of siblings) {
      const r = row as Record<string, unknown>;
      parts.push(`- \`${r.name}\` (${r.kind}) :${r.startLine}`);
    }
  }

  return parts.join('\n');
}

// ===== Helpers =====

function escapeStr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatProp(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    const formatted = value.map(v => {
      if (typeof v === 'object' && v !== null) return JSON.stringify(v);
      return String(v);
    });
    return formatted.slice(0, 10).join(', ') + (value.length > 10 ? `... (+${value.length - 10})` : '');
  }
  if (typeof value === 'object') return JSON.stringify(value).substring(0, 100);
  return String(value);
}

function parseProps(props: unknown): Record<string, unknown> {
  if (typeof props === 'string') {
    try {
      return JSON.parse(props) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (props as Record<string, unknown>) ?? {};
}
