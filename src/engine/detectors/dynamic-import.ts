import { collect } from '../ast-traverser.js';
import type { Detector, DetectorContext, DetectorMatch } from './base.js';

/**
 * Detects dynamic import expressions: () => import('...')
 *
 * Config params:
 *   pattern: string - optional pattern to match the import path
 */
export const ImportExpressionDetector: Detector = {
  name: 'import_expression',

  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[] {
    const pattern = (params.pattern as string) ?? '*';

    const results: DetectorMatch[] = [];

    // Find call_expressions where the function is 'import'
    const callNodes = collect(
      ctx.root,
      (node) =>
        node.type === 'call_expression' &&
        node.childForFieldName('function')?.text === 'import',
    );

    for (const node of callNodes) {
      const args = node.childForFieldName('arguments');
      if (!args) continue;

      for (const child of args.namedChildren) {
        if (child.type === 'string') {
          const path = child.text.replace(/^['"]|['"]$/g, '');
          if (pattern === '*' || path.includes(pattern)) {
            results.push({ importPath: path, line: node.startPosition.row + 1 });
          }
        } else if (child.type === 'template_string') {
          // Template literal like `@/views/${name}.vue`
          results.push({
            importPath: child.text,
            isTemplate: true,
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    return results;
  },
};
