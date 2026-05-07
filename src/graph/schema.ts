import type { ResolvedConfig } from '../types/config.js';
import type { LbugGraph } from './lbug.js';

/**
 * Create a simple schema: single Entity node table with a JSON properties blob.
 * Relation tables are created per config relationship.
 */
export async function createSchema(
  graph: LbugGraph,
  config: ResolvedConfig,
): Promise<void> {
  // Single node table for all entity types
  await graph.execute(`
    CREATE NODE TABLE Entity (
      name STRING,
      filePath STRING,
      entityType STRING,
      properties STRING,
      PRIMARY KEY (filePath)
    )
  `);

  // imports is always auto-detected, so always create its rel table
  await graph.execute(`
    CREATE REL TABLE imports (
      FROM Entity TO Entity,
      properties STRING
    )
  `);

  // Relationship tables for each config-defined relationship
  for (const [relType, relDef] of Object.entries(config.relationships ?? {})) {
    await graph.execute(`
      CREATE REL TABLE ${relType} (
        FROM Entity TO Entity,
        properties STRING
      )
    `);
  }

  // USES_API relationship (Entity → FrameworkAPI) — used for framework API tracking
  if (config.framework_apis?.length) {
    await graph.execute(`
      CREATE NODE TABLE FrameworkAPI (
        name STRING,
        PRIMARY KEY (name)
      )
    `);
    await graph.execute(`
      CREATE REL TABLE USES_API (
        FROM Entity TO Entity,
        properties STRING
      )
    `);
  }
}
