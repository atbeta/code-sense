import type { SyntaxNode } from 'web-tree-sitter';
import { collect, isImportStatement } from '../ast-traverser.js';
import type { Detector, DetectorContext, DetectorMatch } from './base.js';

/**
 * Detects import statements and extracts source + imported names.
 *
 * Config params:
 *   sourcePattern?: string  - glob/regex to match import source
 *   importedPattern?: string - pattern to match imported names
 */
export const ImportStatementDetector: Detector = {
  name: 'import_statement',

  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[] {
    const sourcePattern = params.sourcePattern as string | undefined;
    const importedPattern = params.importedPattern as string | undefined;
    const results: DetectorMatch[] = [];

    const importNodes = collect(ctx.root, isImportStatement);

    for (const node of importNodes) {
      const source = extractImportSource(node);
      const imports = extractImportedNames(node);

      if (sourcePattern && !matchPattern(source, sourcePattern)) continue;

      const filteredImports = importedPattern
        ? imports.filter((i) => matchPattern(i, importedPattern))
        : imports;

      if (filteredImports.length > 0 || !importedPattern) {
        results.push({
          source,
          imports: filteredImports,
          isDefault: node.text.includes('import ') && !node.text.includes('{'),
          nodeText: node.text,
        });
      }
    }

    return results;
  },
};

function extractImportSource(node: SyntaxNode): string {
  // The source is typically a string node child
  for (const child of node.namedChildren) {
    if (child.type === 'string') {
      return child.text.replace(/^['"]|['"]$/g, '');
    }
  }
  return '';
}

function extractImportedNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'import_specifier') {
      // import { Foo } from '...'
      for (const spec of child.namedChildren) {
        if (spec.type === 'identifier') {
          names.push(spec.text);
        }
      }
    } else if (child.type === 'identifier') {
      // import Foo from '...'
      names.push(child.text);
    } else if (child.type === 'namespace_import') {
      // import * as Foo from '...'
      for (const ns of child.namedChildren) {
        if (ns.type === 'identifier') names.push(ns.text);
      }
    }
  }
  return names;
}

function matchPattern(value: string, pattern: string): boolean {
  // Simple glob-like matching: supports * wildcard and literal match
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value.includes(pattern);
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  return regex.test(value);
}
