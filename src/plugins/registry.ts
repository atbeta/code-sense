import type { CodeSensePlugin, DetectionResult } from './types.js';
import type { EntityDefinition, FrameworkAPI, RelationshipDefinition } from '../types/config.js';

export interface ActivatedPlugin {
  plugin: CodeSensePlugin;
  detection: DetectionResult;
}

export class PluginRegistry {
  private plugins: CodeSensePlugin[] = [];
  private activated: ActivatedPlugin[] = [];

  /**
   * Register a built-in or loaded plugin.
   * Must be called before `activate()`.
   */
  register(plugin: CodeSensePlugin): void {
    // Skip if already registered
    if (this.plugins.some((p) => p.name === plugin.name)) return;
    this.plugins.push(plugin);
  }

  /**
   * Run detection on all registered plugins and activate the ones that match.
   * Returns config patches to merge into the resolved config.
   */
  async activate(projectRoot: string): Promise<{
    entities: Record<string, EntityDefinition>;
    frameworkAPIs: FrameworkAPI[];
    relationships: Record<string, RelationshipDefinition>;
  }> {
    const entities: Record<string, EntityDefinition> = {};
    const frameworkAPIs: FrameworkAPI[] = [];
    const relationships: Record<string, RelationshipDefinition> = {};

    for (const plugin of this.plugins) {
      try {
        const result = await plugin.detect(projectRoot);
        if (!result.matched) continue;

        this.activated.push({ plugin, detection: result });

        // Merge entity definitions
        if (result.entities) {
          Object.assign(entities, result.entities);
        }

        // Merge framework APIs
        if (result.frameworkAPIs) {
          frameworkAPIs.push(...result.frameworkAPIs);
        }

        // Merge relationships
        if (result.relationships) {
          Object.assign(relationships, result.relationships);
        }
      } catch (err) {
        console.error(`[CodeSense] Plugin "${plugin.name}" detection failed:`, err);
      }
    }

    return { entities, frameworkAPIs, relationships };
  }

  /** Get all activated plugins */
  getActivated(): ActivatedPlugin[] {
    return [...this.activated];
  }

  /** Get a specific activated plugin by name */
  get(name: string): ActivatedPlugin | undefined {
    return this.activated.find((a) => a.plugin.name === name);
  }

  /** Check if a plugin is activated */
  isActivated(name: string): boolean {
    return this.activated.some((a) => a.plugin.name === name);
  }

  /** Get all registered plugin names (for debugging) */
  listRegistered(): string[] {
    return this.plugins.map((p) => p.name);
  }

  /** Get all activated plugin names */
  listActivated(): string[] {
    return this.activated.map((a) => a.plugin.name);
  }

  /**
   * Run extractEntity on all activated plugins that provide it.
   * Returns merged results.
   */
  async extractEntity(ctx: Parameters<NonNullable<CodeSensePlugin['extractEntity']>>[0]): Promise<{
    properties: Record<string, unknown>;
    apiUsage: { fromFile: string; apiName: string; frameworkName: string }[];
    storeItems: {
      name: string;
      filePath: string;
      type: string;
      properties: Record<string, unknown>;
    }[];
  }> {
    const merged: ReturnType<typeof this.extractEntity> extends Promise<infer T> ? T : never = {
      properties: {},
      apiUsage: [],
      storeItems: [],
    };

    for (const { plugin } of this.activated) {
      if (!plugin.extractEntity) continue;
      try {
        const result = plugin.extractEntity(ctx);
        if (result) {
          Object.assign(merged.properties, result.properties);
          merged.apiUsage.push(...result.apiUsage);
          merged.storeItems.push(...result.storeItems);
        }
      } catch (err) {
        console.error(`[CodeSense] Plugin "${plugin.name}" extractEntity failed:`, err);
      }
    }

    return merged;
  }

  /**
   * Run classifyFunctions on activated plugins.
   * Uses the first plugin that returns results.
   */
  classifyFunctions(
    ctx: Parameters<NonNullable<CodeSensePlugin['classifyFunctions']>>[0],
  ): ReturnType<NonNullable<CodeSensePlugin['classifyFunctions']>> {
    for (const { plugin } of this.activated) {
      if (!plugin.classifyFunctions) continue;
      try {
        const result = plugin.classifyFunctions(ctx);
        if (result && result.functions.length > 0) {
          return result;
        }
      } catch (err) {
        console.error(`[CodeSense] Plugin "${plugin.name}" classifyFunctions failed:`, err);
      }
    }
    return { functions: [] };
  }

  /**
   * Run afterGraphBuilt hook on all activated plugins.
   */
  async afterGraphBuilt(
    ctx: Parameters<NonNullable<CodeSensePlugin['afterGraphBuilt']>>[0],
  ): Promise<void> {
    for (const { plugin } of this.activated) {
      if (!plugin.afterGraphBuilt) continue;
      try {
        await plugin.afterGraphBuilt(ctx);
      } catch (err) {
        console.error(`[CodeSense] Plugin "${plugin.name}" afterGraphBuilt failed:`, err);
      }
    }
  }
}

/** Singleton registry instance */
let registry: PluginRegistry | null = null;

export function getRegistry(): PluginRegistry {
  if (!registry) {
    registry = new PluginRegistry();
  }
  return registry;
}

export function resetRegistry(): void {
  registry = null;
}
