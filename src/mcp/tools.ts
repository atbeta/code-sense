import { resolve, relative, sep } from 'node:path';
import { execSync } from 'node:child_process';
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

  let rows = await ctx.graph.query(
    `MATCH (n:Entity {filePath: '${escapeStr(filePath)}'}) RETURN n`,
  );

  // Fallback: search by filename or entity name if exact path doesn't match
  if (rows.length === 0) {
    const searchName =
      params.filePath
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '') ?? '';
    if (searchName) {
      const altRows = await ctx.graph.query(
        `MATCH (n:Entity {name: '${escapeStr(searchName)}'}) RETURN n`,
      );
      if (altRows.length > 0) rows = altRows;
      else {
        // Try LIKE match on filePath
        const likeRows = await ctx.graph.query(
          `MATCH (n:Entity) WHERE n.filePath CONTAINS '${escapeStr(params.filePath)}' RETURN n`,
        );
        if (likeRows.length > 0) rows = likeRows;
      }
    }
  }

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
  const priorityKeys = [
    'name',
    'variant',
    'apiMode',
    'usesStore',
    'usesComposables',
    'isVue',
    'isRouter',
  ];
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
      parts.push(
        `- **${itemType}** (${names.length}): ${names.slice(0, 20).join(', ')}${names.length > 20 ? '...' : ''}`,
      );
    }
  }

  // Store item usages
  const storeItemUsages = await ctx.graph.query(
    `MATCH (n:Entity {filePath: '${escapeStr(filePath)}'})-[r:uses_store_item]->(s:StoreItem) RETURN s.name as name, s.itemType as itemType, s.storePath as storePath, r.properties as props`,
  );
  if (storeItemUsages.length > 0) {
    parts.push('');
    parts.push('### Store Item Usage');
    for (const row of storeItemUsages) {
      const r = row as Record<string, unknown>;
      const props = parseProps(r.props);
      const storeRel = relative(process.cwd(), (r.storePath as string) || '') || '';
      const line = props.line ? `:${props.line}` : '';
      const evidence = props.evidence ? ` — ${props.evidence}` : '';
      parts.push(`- \`${r.name}\` (${r.itemType}) in \`${storeRel}\`${line}${evidence}`);
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
    parts.push(
      apiNames.slice(0, 30).join(', ') +
        (apiNames.length > 30 ? `... (+${apiNames.length - 30} more)` : ''),
    );
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
      parts.push(
        `- \`${relType}\` → **${r.targetName ?? r.targetPath}** (${r.targetType ?? 'entity'}) \`${targetRel}\``,
      );
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
      parts.push(
        `- **${r.sourceName ?? r.sourcePath}** (${r.sourceType ?? 'entity'}) \`${sourceRel}\` → \`${relType}\``,
      );
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
      parts.push(
        `${indent}- [${imp.relationPath[imp.relationPath.length - 1] || '?'}] → \`${imp.relPath}\``,
      );
    }
  }

  return parts.join('\n');
}

// ===== route_map =====

export async function routeMap(
  ctx: ToolContext,
  params: { routePattern?: string; limit?: number },
): Promise<string> {
  const pattern = params.routePattern ?? '';
  const limit = Math.min(params.limit ?? 50, 200);

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
  parts.push(
    `Total mappings: ${rows.length}${rows.length > limit ? ` (showing first ${limit})` : ''}`,
  );
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

  let shown = 0;
  for (const [routePath, entries] of byRoute) {
    if (shown >= limit) break;
    const relRoute = relative(process.cwd(), routePath) || routePath;
    parts.push(`### \`${relRoute}\``);

    for (const row of entries) {
      if (shown >= limit) break;
      shown++;
      const r = row as Record<string, unknown>;
      const routeProps = parseProps(r.routeProps);
      const rel = r.rel as Record<string, unknown> | undefined;
      const relType = (rel?._label as string) ?? '?';
      const compRel = relative(process.cwd(), (r.componentPath as string) || '') || '?';

      // Try to match edge target to a specific route entry for path/name info
      if (routeProps.routes && Array.isArray(routeProps.routes)) {
        const matched = (routeProps.routes as Array<Record<string, unknown>>).find(
          (route: Record<string, unknown>) => {
            const comp = String(route.component ?? '');
            const compName =
              comp
                .split('/')
                .pop()
                ?.replace(/\.[^.]+$/, '')
                ?.toLowerCase() ?? '';
            const edgeName = (r.componentName as string)?.toLowerCase() ?? '';
            return compName === edgeName;
          },
        );
        if (matched) {
          parts.push(
            `- \`${matched.path ?? '?'}\` (${matched.name ?? 'unnamed'}) → **${r.componentName ?? compRel}** \`${compRel}\``,
          );
          continue;
        }
      }
      parts.push(`- \`${relType}\` → **${r.componentName ?? compRel}** \`${compRel}\``);
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

  const storeItemUsageRows = await ctx.graph.query(
    `MATCH (n:Entity)-[r:uses_store_item]->(s:StoreItem) WHERE s.name = '${escapeStr(name)}' RETURN n.name as entityName, n.filePath as filePath, n.entityType as entityType, s.itemType as itemType, s.storePath as storePath, r.properties as props`,
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

  if (storeItemUsageRows.length > 0) {
    parts.push('');
    parts.push('### Used As Store Item');
    for (const row of storeItemUsageRows) {
      const r = row as Record<string, unknown>;
      const rel = relative(process.cwd(), (r.filePath as string) || '') || '';
      const props = parseProps(r.props);
      const line = props.line ? `:${props.line}` : '';
      const evidence = props.evidence ? ` — ${props.evidence}` : '';
      parts.push(
        `- **${r.entityName ?? rel}** (${r.entityType}) \`${rel}\`${line} uses ${r.itemType}${evidence}`,
      );
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

  if (storeItemRows.length === 0 && storeItemUsageRows.length === 0 && entityRows.length === 0) {
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
        parts.push(
          `- **${r.name ?? rel}** \`${rel}\` (${(props.routes as unknown[]).length} routes defined)`,
        );
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
    return (
      rel.includes(sep + 'views' + sep) ||
      rel.includes(sep + 'pages' + sep) ||
      rel.toLowerCase().includes('app.vue') ||
      rel.toLowerCase().includes('main')
    );
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

export async function cypher(ctx: ToolContext, params: { query: string }): Promise<string> {
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
    const parts: string[] = [`## Function \`${name}\` (${rows.length} matches)`, ''];
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

// ===== diff_impact =====

export async function diffImpact(
  ctx: ToolContext,
  params: { filePath?: string; diffContent?: string; baseRef?: string },
): Promise<string> {
  let diffText: string;

  if (params.diffContent) {
    diffText = params.diffContent;
  } else if (params.filePath) {
    const baseRef = params.baseRef ?? 'HEAD';
    // Resolve: if filePath is relative to source_root, construct the git path
    const gitFilePath = params.filePath;
    try {
      diffText = execSync(`git diff ${baseRef} -- "${gitFilePath}"`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.cwd(),
      });
    } catch {
      return `Failed to run git diff on ${params.filePath}. Make sure this is a git repository.`;
    }
  } else {
    const baseRef = params.baseRef ?? 'HEAD';
    try {
      diffText = execSync(`git diff ${baseRef}`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.cwd(),
      });
    } catch {
      return 'Failed to run git diff. Make sure this is a git repository.';
    }
  }

  if (!diffText.trim()) {
    return 'No changes detected in the diff.';
  }

  // Parse the diff to extract changed files and line ranges
  interface FileChange {
    filePath: string;
    changedRanges: Array<{ start: number; end: number }>;
  }
  const fileChanges: Map<string, FileChange> = new Map();

  const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  let currentFile = '';
  for (const line of diffText.split('\n')) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (fileMatch) {
      currentFile = resolve(process.cwd(), fileMatch[2]);
      if (!fileChanges.has(currentFile)) {
        fileChanges.set(currentFile, { filePath: currentFile, changedRanges: [] });
      }
      continue;
    }

    const hunkMatch = line.match(hunkHeaderRe);
    if (hunkMatch && currentFile) {
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = parseInt(hunkMatch[4] || '1', 10);
      const change = fileChanges.get(currentFile)!;
      change.changedRanges.push({ start: newStart, end: newStart + newCount - 1 });
    }
  }

  if (fileChanges.size === 0) {
    return 'No file changes detected in the diff.';
  }

  const parts: string[] = [
    `## Diff Impact Analysis`,
    params.filePath
      ? `File: \`${relative(process.cwd(), params.filePath)}\` vs ${params.baseRef ?? 'HEAD'}`
      : `Changes vs ${params.baseRef ?? 'HEAD'}`,
    '',
  ];

  interface ImpactedFn {
    name: string;
    kind: string;
    filePath: string;
    line: number;
    impactDepth: number;
    reason: string;
  }

  const allImpacts: ImpactedFn[] = [];
  const seen = new Set<string>();

  for (const [filePath, change] of fileChanges) {
    const relPath =
      relative(ctx.config.project.source_root, filePath) ||
      relative(process.cwd(), filePath) ||
      filePath;

    // Find functions in this file whose line ranges overlap with changed ranges
    const funcRows = await ctx.graph.query(
      `MATCH (f:Function) WHERE f.filePath = '${escapeStr(filePath)}' RETURN f`,
    );

    const directlyChanged: ImpactedFn[] = [];

    for (const row of funcRows) {
      const f = (row as Record<string, unknown>).f as Record<string, unknown>;
      const fnStart = f.startLine as number;
      const fnEnd = f.endLine as number;

      for (const range of change.changedRanges) {
        // Check if the change range overlaps with the function
        if (range.start <= fnEnd && range.end >= fnStart) {
          const name = f.name as string;
          const key = `${filePath}#${name}`;
          if (!seen.has(key)) {
            seen.add(key);
            directlyChanged.push({
              name,
              kind: (f.kind as string) ?? 'function',
              filePath,
              line: fnStart,
              impactDepth: 0,
              reason: `lines ${range.start}-${range.end} changed`,
            });
          }
          break;
        }
      }
    }

    if (directlyChanged.length > 0) {
      parts.push(`### 📝 Changed: \`${relPath}\``);
      for (const fn of directlyChanged) {
        parts.push(`- **${fn.name}** (${fn.kind}) :${fn.line} — ${fn.reason}`);
      }
      allImpacts.push(...directlyChanged);
    } else if (change.changedRanges.length > 0) {
      parts.push(`### 📝 Changed: \`${relPath}\` (no tracked functions in changed regions)`);
    }
  }

  // Trace downstream impact via CALLS edges
  if (allImpacts.length > 0) {
    const downstream = new Map<number, ImpactedFn[]>();
    const queue: Array<{ fnId: string; depth: number }> = [];

    for (const imp of allImpacts) {
      const fnRow = await ctx.graph.query(
        `MATCH (f:Function {id: '${escapeStr(imp.filePath + '#' + imp.name + ':' + imp.line)}'}) RETURN f.id as id`,
      );
      if (fnRow.length > 0) {
        queue.push({
          fnId: (fnRow[0] as Record<string, unknown>).id as string,
          depth: 0,
        });
      }
    }

    const traced = new Set<string>();
    let head = 0;
    while (head < queue.length && head < 200) {
      const { fnId, depth } = queue[head++];
      if (traced.has(fnId)) continue;
      traced.add(fnId);

      if (depth > 0) {
        const calleeRows = await ctx.graph.query(
          `MATCH (f:Function {id: '${escapeStr(fnId)}'}) RETURN f.name as name, f.kind as kind, f.filePath as filePath, f.startLine as startLine`,
        );
        if (calleeRows.length > 0) {
          const f = calleeRows[0] as Record<string, unknown>;
          const list = downstream.get(depth) ?? [];
          list.push({
            name: f.name as string,
            kind: (f.kind as string) ?? 'function',
            filePath: f.filePath as string,
            line: f.startLine as number,
            impactDepth: depth,
            reason: 'downstream CALLS impact',
          });
          downstream.set(depth, list);
        }
      }

      if (depth >= 3) continue;

      // Follow outgoing CALLS
      const nextRows = await ctx.graph.query(
        `MATCH (f:Function {id: '${escapeStr(fnId)}'})-[r:CALLS]->(next:Function) RETURN next.id as id`,
      );
      for (const row of nextRows) {
        queue.push({
          fnId: (row as Record<string, unknown>).id as string,
          depth: depth + 1,
        });
      }
    }

    if (downstream.size > 0) {
      parts.push('');
      parts.push('### ⚠️ Downstream Impact (via CALLS)');
      for (let d = 1; d <= 3; d++) {
        const level = downstream.get(d);
        if (!level || level.length === 0) continue;
        parts.push(`**Depth ${d}** (${level.length} functions)`);
        for (const fn of level) {
          const cRel = relative(ctx.config.project.source_root, fn.filePath);
          parts.push(`- → \`${fn.name}\` (${fn.kind}) in \`${cRel}\` :${fn.line}`);
        }
      }
    }

    // Summary: unique files impacted
    const impactedFiles = new Set<string>();
    for (const imp of allImpacts) impactedFiles.add(imp.filePath);
    for (const [, list] of downstream) {
      for (const fn of list) impactedFiles.add(fn.filePath);
    }

    parts.push('');
    parts.push(
      `**Summary**: ${allImpacts.length} function(s) directly changed, ${traced.size - allImpacts.length} impacted downstream across ${impactedFiles.size} file(s).`,
    );
  }

  return parts.join('\n');
}

// ===== semantic_search =====

function tokenizeCode(text: string): string[] {
  // Code-aware tokenization: split on camelCase, PascalCase, snake_case, kebab-case
  const tokens: string[] = [];
  // Split identifiers: camelCase/PascalCase
  const words = text.split(/[^a-zA-Z0-9_$]+/);
  for (const word of words) {
    if (!word || word.length < 2) continue;
    // Split camelCase: loadUserProfile → load, User, Profile
    const subTokens = word
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/);
    for (const t of subTokens) {
      const lower = t.toLowerCase();
      if (lower.length >= 2 && !/^[0-9_$]+$/.test(lower)) {
        tokens.push(lower);
      }
    }
  }
  return tokens;
}

function computeTFIDF(
  queryTokens: string[],
  docTokens: string[],
  docFreq: Map<string, number>,
  totalDocs: number,
): number {
  // Simple TF-IDF cosine similarity
  const termFreq = new Map<string, number>();
  for (const t of docTokens) {
    termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  }

  let score = 0;
  let queryNorm = 0;
  let docNorm = 0;

  const seenTerms = new Set<string>();
  for (const t of queryTokens) {
    if (seenTerms.has(t)) continue;
    seenTerms.add(t);
    const tf = termFreq.get(t) ?? 0;
    const df = docFreq.get(t) ?? 1;
    const idf = Math.log((totalDocs + 1) / (df + 1)) + 1;
    const qWeight = 1 * idf;
    const dWeight = tf * idf;
    score += qWeight * dWeight;
    queryNorm += qWeight * qWeight;
    docNorm += dWeight * dWeight;
  }

  if (queryNorm === 0 || docNorm === 0) return 0;
  return score / (Math.sqrt(queryNorm) * Math.sqrt(docNorm));
}

export async function semanticSearch(
  ctx: ToolContext,
  params: { query: string; limit?: number; kind?: string },
): Promise<string> {
  const queryStr = params.query.trim();
  if (!queryStr) return 'Please provide a search query.';

  // Load all functions from the graph
  const funcRows = await ctx.graph.query(
    `MATCH (f:Function) RETURN f.id as id, f.name as name, f.kind as kind, f.filePath as filePath, f.startLine as startLine, f.content as content`,
  );

  const queryTokens = tokenizeCode(queryStr.toLowerCase());
  if (queryTokens.length === 0) return 'Query must contain searchable terms.';

  // Build documents
  interface Doc {
    id: string;
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
    tokens: string[];
    fullTokens: string[];
    snippet: string;
  }

  const docs: Doc[] = [];
  const docFreq = new Map<string, number>();

  for (const row of funcRows) {
    const r = row as Record<string, unknown>;
    const kind = (r.kind as string) ?? 'function';
    if (params.kind && kind !== params.kind) continue;

    const name = r.name as string;
    const content = (r.content as string) ?? '';
    const fullText = name + ' ' + content;
    const tokens = tokenizeCode(fullText);
    const uniqueTokens = [...new Set(tokens)];

    for (const t of uniqueTokens) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }

    docs.push({
      id: r.id as string,
      name,
      kind,
      filePath: r.filePath as string,
      startLine: r.startLine as number,
      tokens,
      fullTokens: tokens,
      snippet: content.substring(0, 120).replace(/\n/g, ' '),
    });
  }

  // Also index entities
  const entityRows = await ctx.graph.query(
    `MATCH (e:Entity) RETURN e.name as name, e.filePath as filePath, e.entityType as entityType, e.properties as props`,
  );

  for (const row of entityRows) {
    const r = row as Record<string, unknown>;
    const name = r.name as string;
    const entityType = (r.entityType as string) ?? 'file';
    if (params.kind && entityType !== params.kind) continue;

    let propsText = '';
    try {
      const props = JSON.parse((r.props as string) || '{}');
      propsText = Object.values(props)
        .filter((v) => typeof v === 'string')
        .join(' ');
    } catch {
      /* ignore */
    }

    const fullText = name + ' ' + entityType + ' ' + propsText;
    const tokens = tokenizeCode(fullText);
    const uniqueTokens = [...new Set(tokens)];
    for (const t of uniqueTokens) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }

    docs.push({
      id: (r.filePath as string) ?? '',
      name,
      kind: entityType,
      filePath: r.filePath as string,
      startLine: 0,
      tokens,
      fullTokens: tokens,
      snippet: `[${entityType}]`,
    });
  }

  // Score documents
  const scored = docs.map((doc) => ({
    ...doc,
    score: computeTFIDF(queryTokens, doc.fullTokens, docFreq, docs.length),
  }));

  // Boost by name match
  const queryLower = queryStr.toLowerCase();
  for (const s of scored) {
    if (s.name.toLowerCase() === queryLower) s.score += 0.5;
    else if (s.name.toLowerCase().includes(queryLower)) s.score += 0.3;
    if (s.name.toLowerCase().startsWith(queryLower)) s.score += 0.2;
  }

  scored.sort((a, b) => b.score - a.score);

  const limit = Math.min(params.limit ?? 15, 30);
  const top = scored.filter((s) => s.score > 0).slice(0, limit);

  if (top.length === 0) {
    // If kind filter is set and no results matched, fall back to listing by kind
    if (params.kind) {
      const kindRows = await ctx.graph.query(
        `MATCH (f:Function) WHERE f.kind = '${escapeStr(params.kind)}' RETURN f.name as name, f.kind as kind, f.filePath as filePath, f.startLine as startLine, f.content as content LIMIT ${limit}`,
      );
      if (kindRows.length > 0) {
        const parts: string[] = [
          `## 🔍 Semantic Search: "${queryStr}" (filtered by kind: ${params.kind})`,
          `No semantic matches. Showing ${kindRows.length} ${params.kind}(s):`,
          '',
        ];
        for (let i = 0; i < kindRows.length; i++) {
          const r = kindRows[i] as Record<string, unknown>;
          const cRel = relative(ctx.config.project.source_root, (r.filePath as string) || '');
          parts.push(`**${i + 1}.** \`${r.name}\` :${r.startLine}`);
          parts.push(`   📁 \`${cRel}\``);
          const snippet = ((r.content as string) ?? '').substring(0, 80).replace(/\n/g, ' ');
          if (snippet) parts.push(`   📄 ${snippet}`);
          parts.push('');
        }
        return parts.join('\n');
      }
    }
    return `No results found for "${queryStr}". Try different keywords.`;
  }

  const parts: string[] = [
    `## 🔍 Semantic Search: "${queryStr}"`,
    `Found ${top.length} results:`,
    '',
  ];

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const cRel = relative(ctx.config.project.source_root, r.filePath);
    const scorePct = Math.round(r.score * 100);
    parts.push(`**${i + 1}.** \`${r.name}\` (${r.kind}) — score: ${scorePct}%`);
    parts.push(`   📁 \`${cRel}\` :${r.startLine || '—'}`);
    if (r.snippet) {
      parts.push(`   📄 ${r.snippet}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

// ===== Helpers =====

function escapeStr(value: string): string {
  // TODO: centralize Cypher parameterization/escaping across graph and MCP query paths.
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatProp(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    const formatted = value.map((v) => {
      if (typeof v === 'object' && v !== null) return JSON.stringify(v);
      return String(v);
    });
    return (
      formatted.slice(0, 10).join(', ') + (value.length > 10 ? `... (+${value.length - 10})` : '')
    );
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
