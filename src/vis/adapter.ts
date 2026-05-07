import type { LbugGraph } from '../graph/lbug.js';

export interface VisNode {
  key: string;
  label: string;
  entityType: string;
  filePath: string;
  properties: Record<string, unknown>;
}

export interface VisEdge {
  source: string;
  target: string;
  relType: string;
  properties: Record<string, unknown>;
}

export interface VisGraph {
  nodes: VisNode[];
  edges: VisEdge[];
}

/**
 * Convert the LadybugDB graph to a JSON-serializable format
 * suitable for graphology / Sigma.js rendering.
 */
export async function graphToVis(graph: LbugGraph): Promise<VisGraph> {
  const nodes: VisNode[] = [];
  const nodeKeys = new Set<string>();

  const entityRows = await graph.query(
    `MATCH (n:Entity) RETURN n.name as name, n.filePath as filePath, n.entityType as entityType, n.properties as properties`,
  );

  for (const row of entityRows) {
    const r = row as Record<string, unknown>;
    const key = (r.filePath as string) ?? '';
    if (nodeKeys.has(key)) continue;
    nodeKeys.add(key);

    let rawProps: Record<string, unknown> = {};
    if (typeof r.properties === 'string') {
      try {
        rawProps = JSON.parse(r.properties) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      if (!k.startsWith('_')) props[k] = v;
    }

    nodes.push({
      key,
      label: (r.name as string) ?? key,
      entityType: (r.entityType as string) ?? 'unknown',
      filePath: key,
      properties: props,
    });
  }

  const edges: VisEdge[] = [];
  const edgeSet = new Set<string>();

  // Get all relationships — r._label carries the relationship type
  const edgeRows = await graph.query(
    `MATCH (a:Entity)-[r]->(b:Entity) RETURN a.filePath as source, b.filePath as target, r as rel`,
  );
  for (const row of edgeRows) {
    const r = row as Record<string, unknown>;
    const source = r.source as string;
    const target = r.target as string;
    const rel = r.rel as Record<string, unknown> | undefined;
    const relType = (rel?._label as string) ?? 'unknown';
    const key = `${source}|${relType}|${target}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);

    let props: Record<string, unknown> = {};
    if (typeof rel?.properties === 'string') {
      try {
        props = JSON.parse(rel.properties) as Record<string, unknown>;
      } catch {
        // ignore
      }
    }

    edges.push({ source, target, relType, properties: props });
  }

  return { nodes, edges };
}
