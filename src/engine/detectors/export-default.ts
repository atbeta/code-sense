import { collect } from '../ast-traverser.js';
import type { Detector, DetectorContext, DetectorMatch } from './base.js';

/**
 * Detects `export default { ... }` and extracts the exported object properties.
 *
 * Useful for extracting Options API component definition:
 *   export default { name: 'Xxx', data() {...}, methods: {...} }
 *
 * Config params:
 *   extract: string[] - property names to extract (e.g., ['name', 'data', 'methods'])
 */
export const ExportDefaultDetector: Detector = {
  name: 'export_default',

  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[] {
    const extract = (params.extract as string[]) ?? [];
    const results: DetectorMatch[] = [];

    // Find export_statement containing 'default'
    const exportNodes = collect(
      ctx.root,
      (node) => node.type === 'export_statement' && node.text.includes('default'),
    );

    for (const node of exportNodes) {
      const match: DetectorMatch = {
        hasDefaultExport: true,
        line: node.startPosition.row + 1,
      };

      // Try to find the exported object literal
      for (const child of node.namedChildren) {
        if (child.type === 'object' || child.type === 'object_literal') {
          extractObjectProperties(child, extract, match);
        }
        // Handle `export default Vue.extend({...})`
        if (child.type === 'call_expression') {
          const args = child.childForFieldName('arguments');
          if (args) {
            for (const arg of args.namedChildren) {
              if (arg.type === 'object' || arg.type === 'object_literal') {
                extractObjectProperties(arg, extract, match);
              }
            }
          }
        }
      }

      results.push(match);
    }

    return results;
  },
};

function extractObjectProperties(
  objNode: import('web-tree-sitter').SyntaxNode,
  extract: string[],
  match: DetectorMatch,
): void {
  for (const child of objNode.namedChildren) {
    // Each property is a 'pair' node: key: value
    if (child.type === 'pair') {
      const key = child.childForFieldName('key');
      const value = child.childForFieldName('value');
      if (key && (extract.length === 0 || extract.includes(key.text))) {
        match[key.text] = {
          type: value?.type ?? 'unknown',
          text: value?.text ?? '',
          line: child.startPosition.row + 1,
        };
      }
    }
  }
}
