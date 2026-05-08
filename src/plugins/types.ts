import type { EntityDefinition, FrameworkAPI, RelationshipDefinition } from '../types/config.js';
import type { EntityInstance, RelationInstance } from '../types/graph.js';
import type { SyntaxNode } from 'web-tree-sitter';

// ===== Plugin Detection Result =====

export interface DetectionResult {
  /** Whether this plugin applies to the project */
  matched: boolean;
  /** Confidence score 0-1 */
  confidence: number;
  /** Matched signals (files, deps, patterns) */
  signals: DetectionSignal[];
  /** Entity type definitions to register when matched */
  entities?: Record<string, EntityDefinition>;
  /** Framework API registrations */
  frameworkAPIs?: FrameworkAPI[];
  /** Relationship definitions */
  relationships?: Record<string, RelationshipDefinition>;
}

export interface DetectionSignal {
  type: 'dependency' | 'file_pattern' | 'config_file' | 'inline_marker';
  value: string;
  description?: string;
}

// ===== Plugin Extraction Context =====

export interface EntityExtractionContext {
  /** Full ABSOLUTE path to the source file */
  filePath: string;
  /** File content (utf-8) */
  source: string;
  /** Parsed AST root node */
  astRoot: SyntaxNode;
  /** Entity type being processed */
  entityType: string;
  /** Language ('js' | 'ts') */
  language: 'js' | 'ts';
  /** Full resolved config */
  config: import('../types/config.js').ResolvedConfig;
  /** Project root (config dir) */
  projectRoot: string;
  /** Source root (absolute) */
  sourceRoot: string;
}

export interface EntityExtractionResult {
  /** Properties to merge into the entity */
  properties: Record<string, unknown>;
  /** Framework API usage found in this file */
  apiUsage: { fromFile: string; apiName: string; frameworkName: string }[];
  /** Store items (state/getters/actions/mutations) */
  storeItems: {
    name: string;
    filePath: string;
    type: string;
    properties: Record<string, unknown>;
  }[];
}

export interface FunctionExtractionContext {
  filePath: string;
  entityType: string;
  astRoot: SyntaxNode;
  sfc?: { usesScriptSetup?: boolean; mainScript?: { attrs: string } } | null;
}

export interface FunctionExtractionResult {
  functions: Array<{
    id: string;
    name: string;
    filePath: string;
    entityPath: string;
    kind:
      | 'function'
      | 'method'
      | 'composable_function'
      | 'setup_function'
      | 'store_action'
      | 'store_mutation';
    startLine: number;
    endLine: number;
    content: string;
  }>;
}

// ===== Plugin Post-Processing Hooks =====

export interface GraphPostProcessContext {
  entities: EntityInstance[];
  relations: RelationInstance[];
  /** LadybugDB graph instance for direct queries and edge creation */
  graph: import('../graph/lbug.js').LbugGraph;
  /** Project root (config dir) */
  projectRoot: string;
  /** Resolved config */
  config: import('../types/config.js').ResolvedConfig;
}

// ===== CodeSense Plugin Interface =====

export interface CodeSensePlugin {
  /** Unique plugin identifier (e.g. 'vue', 'react', 'java') */
  readonly name: string;

  /** Human-readable description */
  readonly description: string;

  /** Plugin version */
  readonly version: string;

  // ── Detection ──

  /**
   * Detect whether this plugin applies to the project.
   * Called during `codesense index` to decide if plugin should be activated.
   */
  detect(projectRoot: string): Promise<DetectionResult> | DetectionResult;

  // ── Entity Extraction ──

  /**
   * Extract framework-specific properties from a source file entity.
   * Called for every scanned file whose entityType matches one of this plugin's types.
   *
   * Return null/empty if no special extraction needed for this file.
   */
  extractEntity?(ctx: EntityExtractionContext): EntityExtractionResult;

  /**
   * Extract function/method definitions with framework-aware classification.
   * Called for every scanned file.
   */
  classifyFunctions?(ctx: FunctionExtractionContext): FunctionExtractionResult;

  // ── Graph Hooks ──

  /**
   * Called after all entities/functions are written to the graph.
   * Use for cross-file analysis, building derived edges, etc.
   */
  afterGraphBuilt?(ctx: GraphPostProcessContext): Promise<void>;
}
