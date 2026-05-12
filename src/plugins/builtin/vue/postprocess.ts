/**
 * Vue Plugin — Post-Processing
 *
 * Runs after the graph is built to create edges that can't be
 * easily detected via the declarative detector system:
 * - uses_mixin: component → mixin name matching
 * - uses_component: component → component template tag matching
 * - uses_store_item: component → StoreItem member/map-helper matching
 * - ipc_channel: electron-main ↔ preload ↔ renderer IPC channel matching
 *
 * `postProcessMixins` is the historical plugin hook name, but it now
 * orchestrates all Vue plugin post-processing steps.
 */
import type { GraphPostProcessContext } from '../../types.js';
import type { EntityInstance } from '../../../types/graph.js';
import { postProcessStoreItemUsage } from './postprocess-store.js';
import { postProcessTemplateComponents } from './postprocess-template.js';

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

  // Run the remaining Vue post-processing passes.
  await postProcessStoreItemUsage(ctx);
  await postProcessTemplateComponents(ctx);
  await postProcessIPC(ctx);
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
