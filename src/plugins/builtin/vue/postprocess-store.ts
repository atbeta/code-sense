import type { GraphPostProcessContext } from '../../types.js';

interface StoreItemUsage {
  itemName: string;
  itemType?: string;
  storeAlias?: string;
  storeName?: string;
  line: number;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

interface StoreItemRow {
  itemName: string;
  itemType: string;
  storePath: string;
  itemPath: string;
}

export async function postProcessStoreItemUsage(ctx: GraphPostProcessContext): Promise<void> {
  const { graph, entities } = ctx;
  const storeItems = await loadStoreItems(graph);
  if (storeItems.length === 0) return;

  for (const entity of entities) {
    if (!['component', 'page', 'layout'].includes(entity.type)) continue;

    const usages = entity.properties.storeItemUsages as StoreItemUsage[] | undefined;
    if (!usages || usages.length === 0) continue;

    for (const usage of usages) {
      const target = findStoreItem(usage, storeItems);
      if (!target) continue;

      try {
        await graph.createStoreItemRel(entity.filePath, target.itemPath, 'uses_store_item', {
          itemName: usage.itemName,
          itemType: target.itemType,
          storeName: usage.storeName,
          storeAlias: usage.storeAlias,
          line: usage.line,
          confidence: usage.confidence,
          evidence: usage.evidence,
        });
      } catch {
        // ignore duplicate or unavailable target
      }
    }
  }
}

async function loadStoreItems(graph: GraphPostProcessContext['graph']): Promise<StoreItemRow[]> {
  const rows = await graph.query(
    `MATCH (s:StoreItem) RETURN s.name as itemName, s.itemType as itemType, s.storePath as storePath, s.filePath as itemPath`,
  );
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      itemName: String(r.itemName ?? ''),
      itemType: String(r.itemType ?? ''),
      storePath: String(r.storePath ?? ''),
      itemPath: String(r.itemPath ?? ''),
    };
  });
}

function findStoreItem(
  usage: StoreItemUsage,
  storeItems: StoreItemRow[],
): StoreItemRow | undefined {
  const itemMatches = storeItems.filter(
    (item) =>
      normalizeName(item.itemName) === normalizeName(usage.itemName) &&
      (!usage.itemType || item.itemType === usage.itemType),
  );
  if (itemMatches.length === 0) return undefined;

  if (usage.storeName) {
    const exactStoreMatch = itemMatches.find((item) =>
      storePathMatchesName(item.storePath, usage.storeName ?? '', 'exact'),
    );
    if (exactStoreMatch) return exactStoreMatch;

    const fuzzyStoreMatch = itemMatches.find((item) =>
      storePathMatchesName(item.storePath, usage.storeName ?? '', 'fuzzy'),
    );
    if (fuzzyStoreMatch) return fuzzyStoreMatch;
  }

  return itemMatches.length === 1 ? itemMatches[0] : undefined;
}

function storePathMatchesName(
  storePath: string,
  storeName: string,
  mode: 'exact' | 'fuzzy',
): boolean {
  const basename =
    storePath
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? '';
  const normalizedBase = normalizeName(basename);
  const normalizedStore = normalizeName(storeName);
  if (mode === 'exact') return normalizedBase === normalizedStore;
  return normalizedBase.includes(normalizedStore) || normalizedStore.includes(normalizedBase);
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
