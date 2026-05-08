import type { ResolvedConfig } from '../types/config.js';
import type { LbugGraph } from './lbug.js';

/**
 * Create the full graph schema.
 * Since LadybugDB doesn't support CREATE TABLE IF NOT EXISTS,
 * we delete the existing database directory to start fresh.
 */
export async function createSchema(graph: LbugGraph, config: ResolvedConfig): Promise<void> {
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
  // Skip 'imports' since it's always auto-created above
  for (const [relType, _relDef] of Object.entries(config.relationships ?? {})) {
    if (relType === 'imports') continue;
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
        FROM Entity TO FrameworkAPI,
        properties STRING
      )
    `);
  }

  // Sub-entity tables for store internals (state, getters, actions, mutations)
  await graph.execute(`
    CREATE NODE TABLE StoreItem (
      name STRING,
      filePath STRING,
      itemType STRING,
      storePath STRING,
      properties STRING,
      PRIMARY KEY (filePath)
    )
  `);

  await graph.execute(`
    CREATE REL TABLE has_item (
      FROM Entity TO StoreItem,
      properties STRING
    )
  `);

  // Function/method-level granularity
  await graph.execute(`
    CREATE NODE TABLE Function (
      id STRING,
      name STRING,
      filePath STRING,
      entityPath STRING,
      kind STRING,
      startLine INT64,
      endLine INT64,
      content STRING,
      PRIMARY KEY (id)
    )
  `);

  await graph.execute(`
    CREATE REL TABLE CALLS (
      FROM Function TO Function,
      confidence DOUBLE,
      callSite STRING
    )
  `);

  await graph.execute(`
    CREATE REL TABLE defines (
      FROM Entity TO Function,
      properties STRING
    )
  `);
}
