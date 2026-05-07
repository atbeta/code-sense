import type { SyntaxNode } from 'web-tree-sitter';

export interface DetectorMatch {
  /** Arbitrary key-value data extracted by the detector */
  [key: string]: unknown;
}

export interface DetectorContext {
  /** The file content (for regex/text-based matching) */
  source: string;
  /** The parsed AST root */
  root: SyntaxNode;
  /** The SFC template block content, if this is a .vue file */
  templateContent?: string;
  /** The SFC script block content */
  scriptContent?: string;
}

export interface Detector {
  readonly name: string;
  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[];
}

/**
 * Built-in detector names that the engine provides.
 * Config references these by name.
 */
export const BUILTIN_DETECTORS = [
  'import_statement',
  'call_expression',
  'new_expression',
  'member_expression',
  'import_expression',
  'export_default',
  'annotation',
  'template_element',
  'compiler_macro',
] as const;

export type BuiltinDetectorName = (typeof BUILTIN_DETECTORS)[number];
