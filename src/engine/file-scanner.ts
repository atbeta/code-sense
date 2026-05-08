import fg from 'fast-glob';
import { sep } from 'node:path';
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

  for (const [entityType, entityDef] of Object.entries(config.all_entities)) {
    // Patterns are relative to sourceRoot, pass cwd to fast-glob for correct cross-platform globs
    const files = await fg(entityDef.patterns, {
      cwd: sourceRoot,
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

      const relPath = filePath.startsWith(sourceRoot + sep)
        ? filePath.slice(sourceRoot.length + sep.length)
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
