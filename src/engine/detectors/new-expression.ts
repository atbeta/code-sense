import { collect, isNewExpression } from '../ast-traverser.js';
import type { Detector, DetectorContext, DetectorMatch } from './base.js';

/**
 * Detects `new Xxx(...)` expressions.
 *
 * Config params:
 *   pattern: string - pattern to match the constructor (e.g., 'Vuex.Store')
 */
export const NewExpressionDetector: Detector = {
  name: 'new_expression',

  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[] {
    const pattern = params.pattern as string;
    if (!pattern) return [];

    const results: DetectorMatch[] = [];
    const newNodes = collect(ctx.root, isNewExpression);

    for (const node of newNodes) {
      const constructorName = extractConstructor(node);

      if (!matchPattern(constructorName, pattern)) continue;

      results.push({
        constructor: constructorName,
        arguments: extractArguments(node),
        line: node.startPosition.row + 1,
      });
    }

    return results;
  },
};

function extractConstructor(node: import('web-tree-sitter').SyntaxNode): string {
  const ctor = node.childForFieldName('constructor');
  return ctor?.text ?? '';
}

function extractArguments(
  node: import('web-tree-sitter').SyntaxNode,
): string[] {
  const argsNode = node.childForFieldName('arguments');
  if (!argsNode) return [];
  const args: string[] = [];
  for (const child of argsNode.namedChildren) {
    if (child.type !== ',' && child.type !== '(' && child.type !== ')') {
      args.push(child.text);
    }
  }
  return args;
}

function matchPattern(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (value === pattern) return true;
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(value);
  }
  if (value.includes(pattern)) return true;
  return false;
}
