import type { GraphPostProcessContext } from '../../types.js';
import type { EntityInstance } from '../../../types/graph.js';

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
