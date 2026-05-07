// ===== Project config =====

export interface ProjectConfig {
  name: string;
  source_root: string;
}

// ===== Entity definitions =====

export interface EntityProperty {
  name: string;
  extract: string; // AST path or built-in detector name
}

export interface EntityMarker {
  import_contains?: string;
  template_contains?: string;
  uses_options_api?: boolean;
  naming_pattern?: string;
}

export interface StoreVariant {
  detector: 'call_expression' | 'new_expression';
  pattern: string;
  internal_structure?: {
    state?: string;
    getters?: string;
    mutations?: string;
    actions?: string;
  };
}

export interface EntityDefinition {
  patterns: string[];
  properties?: EntityProperty[];
  variants?: Record<string, StoreVariant>;
  markers?: EntityMarker[];
  description?: string;
}

// ===== Framework API =====

export interface FrameworkAPI {
  name: string;
  sources: string[];
  api_list: string[];
  compiler_macros?: string[];
}

// ===== Relationship definitions =====

export interface RelationshipDetector {
  type: string;
  pattern?: string;
}

export interface RelationshipDefinition {
  description?: string;
  from: string;
  to: string;
  detector?: string;
  detect_by?: RelationshipDetector[];
}

// ===== Top-level config =====

export interface CodeSenseConfig {
  project: ProjectConfig;
  entities: Record<string, EntityDefinition>;
  framework_apis?: FrameworkAPI[];
  relationships?: Record<string, RelationshipDefinition>;
  custom_entities?: Record<string, EntityDefinition>;
}

// ===== Resolved config (merged with defaults) =====

export interface ResolvedConfig extends CodeSenseConfig {
  all_entities: Record<string, EntityDefinition>; // entities + custom_entities merged
}
