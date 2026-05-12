/**
 * Vue Plugin — Post-Processing
 *
 * Runs after the graph is built to create edges that can't be
 * easily detected via the declarative detector system:
 * - uses_mixin: component → mixin name matching
 * - uses_component: component → component template tag matching
 * - uses_store_item: component → StoreItem member/map-helper matching
 * - ipc_channel: electron-main ↔ preload ↔ renderer IPC channel matching
 */
import type { GraphPostProcessContext } from '../../types.js';
import type { EntityInstance } from '../../../types/graph.js';

export async function postProcessMixins(ctx: GraphPostProcessContext): Promise<void> {
  const { graph, entities } = ctx;

  // Find all components that use mixins
  for (const entity of entities) {
    if (entity.type !== 'component') continue;

    const mixinNames = entity.properties.mixinNames as string[] | undefined;
    if (!mixinNames || mixinNames.length === 0) continue;

    for (const mixinName of mixinNames) {
      const matchingMixin = entities.find((e: EntityInstance) => {
        if (e.type !== 'mixin') return false;
        const basename =
          e.filePath
            .split('/')
            .pop()
            ?.replace(/\.[^.]+$/, '') ?? '';
        const normalized = mixinName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const fileNorm = basename.toLowerCase().replace(/[^a-z0-9]/g, '');
        return (
          normalized === fileNorm || fileNorm.includes(normalized) || normalized.includes(fileNorm)
        );
      });

      if (matchingMixin) {
        try {
          await graph.createRel(entity.filePath, matchingMixin.filePath, 'uses_mixin', {
            mixinName,
            confidence: 'medium',
            evidence: `mixins: [${mixinName}] declaration in component`,
          });
        } catch {
          // edge may already exist or target doesn't exist
        }
      }
    }
  }

  // Electron IPC channel cross-referencing
  await postProcessStoreItemUsage(ctx);
  await postProcessTemplateComponents(ctx);
  await postProcessIPC(ctx);
}

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

export async function postProcessTemplateComponents(ctx: GraphPostProcessContext): Promise<void> {
  const { graph, entities } = ctx;
  const vueEntityTypes = new Set(['component', 'page', 'layout']);
  const candidates = entities.filter((e) => vueEntityTypes.has(e.type));

  for (const entity of candidates) {
    const usages = entity.properties.templateComponents as
      | Array<{ tag: string; line: number }>
      | undefined;
    if (!usages || usages.length === 0) continue;

    for (const usage of usages) {
      const target = findComponentByTag(usage.tag, candidates, entity.filePath);
      if (!target) continue;

      try {
        await graph.createRel(entity.filePath, target.filePath, 'uses_component', {
          tag: usage.tag,
          line: usage.line,
          confidence: 'medium',
          evidence: `<${usage.tag}> tag in template`,
        });
      } catch {
        // edge table may be unavailable in hand-written configs from older graphs
      }
    }
  }
}

export async function postProcessIPC(ctx: GraphPostProcessContext): Promise<void> {
  const { graph, entities } = ctx;

  // Collect main process handlers
  const mainHandlers = new Map<string, { entity: EntityInstance; channels: Set<string> }>();
  for (const entity of entities) {
    if (entity.type !== 'electron-main') continue;
    const handlers = entity.properties.ipcHandlers as
      | Array<{ channel: string; line: number; type: string }>
      | undefined;
    if (!handlers || handlers.length === 0) continue;
    const channels = new Set(handlers.map((h) => h.channel));
    mainHandlers.set(entity.filePath, { entity, channels });
  }

  // Collect preload bridges
  const preloadBridges: Array<{ entity: EntityInstance; namespace: string; methods: string[] }> =
    [];
  for (const entity of entities) {
    if (entity.type !== 'preload') continue;
    const bridge = entity.properties.preloadBridge as
      | { namespace: string; methods: string[] }
      | undefined;
    if (!bridge) continue;
    preloadBridges.push({ entity, namespace: bridge.namespace, methods: bridge.methods });
  }

  // Collect renderer IPC calls
  const rendererCalls = new Map<
    string,
    Array<{ entity: EntityInstance; channel: string; type: string }>
  >();
  for (const entity of entities) {
    if (!['component', 'page', 'layout'].includes(entity.type)) continue;
    const calls = entity.properties.ipcCalls as
      | Array<{ channel: string; line: number; type: string }>
      | undefined;
    if (!calls || calls.length === 0) continue;
    for (const call of calls) {
      const list = rendererCalls.get(call.channel) ?? [];
      list.push({ entity, channel: call.channel, type: call.type });
      rendererCalls.set(call.channel, list);
    }
  }

  // Match renderer IPC calls to main process handlers by channel name
  for (const [channel, callers] of rendererCalls) {
    const normChannel = normalizeChannel(channel);
    for (const [mainPath, main] of mainHandlers) {
      for (const mainChannel of main.channels) {
        if (normChannel === normalizeChannel(mainChannel)) {
          for (const caller of callers) {
            try {
              await graph.createRel(caller.entity.filePath, mainPath, 'calls_ipc', {
                channel,
                mainChannel,
                direction: 'renderer→main',
                confidence: 'high',
                evidence: "ipcRenderer.invoke/send('" + channel + "')",
              });
            } catch {
              /* ignore */
            }
          }
          break; // one channel match per handler file
        }
      }
    }
  }

  // Link preload bridges to main process (preload loads in main context)
  for (const bridge of preloadBridges) {
    for (const method of bridge.methods) {
      const normMethod = normalizeChannel(method);
      for (const [mainPath, main] of mainHandlers) {
        for (const mainChannel of main.channels) {
          if (normMethod === normalizeChannel(mainChannel)) {
            try {
              await graph.createRel(bridge.entity.filePath, mainPath, 'exposes_ipc', {
                channel: method,
                mainChannel,
                namespace: bridge.namespace,
                confidence: 'high',
                evidence:
                  "contextBridge.exposeInMainWorld('" + bridge.namespace + "', { " + method + ' })',
              });
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  }
}

function normalizeChannel(channel: string): string {
  return channel.toLowerCase().replace(/[-_]/g, '');
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findComponentByTag(
  tag: string,
  candidates: EntityInstance[],
  sourcePath: string,
): EntityInstance | undefined {
  const normalizedTag = normalizeComponentName(tag);
  if (!normalizedTag) return undefined;

  return candidates.find((candidate) => {
    if (candidate.filePath === sourcePath) return false;
    return componentAliases(candidate).some((alias) => alias === normalizedTag);
  });
}

function componentAliases(entity: EntityInstance): string[] {
  const aliases = new Set<string>();
  const propName = entity.properties.name;
  if (typeof propName === 'string') aliases.add(normalizeComponentName(propName));

  const basename =
    entity.filePath
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? '';
  aliases.add(normalizeComponentName(basename));

  return [...aliases].filter(Boolean);
}

function normalizeComponentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
