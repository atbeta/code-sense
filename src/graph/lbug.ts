import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import lbug from '@ladybugdb/core';

export class LbugGraph {
  private db: lbug.Database;
  private conn: lbug.Connection;
  private createdRels = new Set<string>();

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new lbug.Database(dbPath);
    this.conn = new lbug.Connection(this.db);
  }

  async query(cypher: string): Promise<Record<string, unknown>[]> {
    const result = await this.conn.query(cypher);
    const qr = result as unknown as {
      getAll: () => Promise<unknown[]>;
      close: () => Promise<void>;
    };
    const rows = (await qr.getAll()).map((row: unknown) => row as Record<string, unknown>);
    await qr.close();
    return rows;
  }

  async execute(cypher: string): Promise<void> {
    const result = await this.conn.query(cypher);
    const qr = result as unknown as { close: () => Promise<void> };
    await qr.close();
  }

  /**
   * Upsert an Entity node. All dynamic properties are stored as JSON in the `properties` column.
   */
  async upsertEntity(
    name: string,
    filePath: string,
    entityType: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const propsJson = JSON.stringify(extra);
    const escapedName = escapeCypher(name);
    const escapedPath = escapeCypher(filePath);
    const escapedType = escapeCypher(entityType);

    await this.execute(`
      MERGE (n:Entity {filePath: ${escapedPath}})
      ON CREATE SET n.name = ${escapedName}, n.entityType = ${escapedType}, n.properties = ${escapeCypher(propsJson)}
      ON MATCH SET n.name = ${escapedName}, n.entityType = ${escapedType}, n.properties = ${escapeCypher(propsJson)}
    `);
  }

  /**
   * Create a relationship edge between two Entity nodes.
   */
  async createRel(
    fromPath: string,
    toPath: string,
    relType: string,
    relProps?: Record<string, unknown>,
  ): Promise<void> {
    const key = `${fromPath}||${toPath}||${relType}`;
    if (this.createdRels.has(key)) return;
    this.createdRels.add(key);

    // LadybugDB only allows ONE edge (of any type) between a node pair.
    // Check if any edge already exists before creating.
    const existing = await this.query(`
      MATCH (a:Entity {filePath: ${escapeCypher(fromPath)}})-[r]->(b:Entity {filePath: ${escapeCypher(toPath)}})
      RETURN r
      LIMIT 1
    `);
    if (existing.length > 0) return;

    const propsStr = relProps ? `{properties: ${escapeCypher(JSON.stringify(relProps))}}` : '';
    await this.execute(`
      MATCH (a:Entity {filePath: ${escapeCypher(fromPath)}})
      MATCH (b:Entity {filePath: ${escapeCypher(toPath)}})
      CREATE (a)-[:${relType} ${propsStr}]->(b)
    `);
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.db.close();
  }
}

function escapeCypher(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
