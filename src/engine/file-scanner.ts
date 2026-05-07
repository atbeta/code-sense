import fg from 'fast-glob';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import type { EntityDefinition, ResolvedConfig } from '../types/config.js';

export interface ScannedFile {
  filePath: string;
  relativePath: string;
  entityType: string;
  entityDef: EntityDefinition;
}

/**
 * Scan the source root against all entity patterns from config.
 * Returns files tagged with their matching entity type.
 */
export async function scanFiles(
  config: ResolvedConfig,
  sourceRoot: string,
): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];
  const seen = new Set<string>();

  for (const [entityType, entityDef] of Object.entries(
    config.all_entities,
  )) {
    // Patterns are relative to CWD (project root), not sourceRoot
    const patterns = entityDef.patterns.map((p) =>
      resolve(p),
    );

    const files = await fg(patterns, {
      absolute: true,
      onlyFiles: true,
      ignore: ['**/node_modules/**'],
    });

    for (const filePath of files) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);

      // Skip files that don't exist or are empty
      try {
        if (statSync(filePath).size === 0) continue;
      } catch {
        continue;
      }

      const relPath = filePath.startsWith(sourceRoot + '/')
        ? filePath.slice(sourceRoot.length + 1)
        : filePath;
      results.push({
        filePath,
        relativePath: relPath,
        entityType,
        entityDef,
      });
    }
  }

  return results;
}
