/**
 * Vue Plugin — Post-Processing
 *
 * Runs after the graph is built to create edges that can't be
 * easily detected via the declarative detector system:
 * - uses_mixin: component → mixin name matching
 */
import type { GraphPostProcessContext } from '../../types.js';
import type { EntityInstance } from '../../../types/graph.js';

export async function postProcessMixins(ctx: GraphPostProcessContext): Promise<void> {
  const { graph, config, entities } = ctx;

  // Find all components that use mixins
  for (const entity of entities) {
    if (entity.type !== 'component') continue;

    const mixinNames = entity.properties.mixinNames as string[] | undefined;
    if (!mixinNames || mixinNames.length === 0) continue;

    // Find matching mixin entities
    for (const mixinName of mixinNames) {
      const matchingMixin = entities.find(
        (e: EntityInstance) => {
          if (e.type !== 'mixin') return false;
          const basename = e.filePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
          // Match: MyMixin → MyMixin.js, my-mixin.js, myMixin.js
          const normalized = mixinName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const fileNorm = basename.toLowerCase().replace(/[^a-z0-9]/g, '');
          return normalized === fileNorm || fileNorm.includes(normalized) || normalized.includes(fileNorm);
        },
      );

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
}
