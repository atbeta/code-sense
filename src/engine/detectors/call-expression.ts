import { collect, isCallExpression } from '../ast-traverser.js';
import type { Detector, DetectorContext, DetectorMatch } from './base.js';

/**
 * Detects function call expressions matching a pattern.
 *
 * Config params:
 *   pattern: string - pattern to match the callee (e.g., 'defineStore', 'use*Store', 'map*')
 */
export const CallExpressionDetector: Detector = {
  name: 'call_expression',

  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[] {
    const pattern = params.pattern as string;
    if (!pattern) return [];

    const results: DetectorMatch[] = [];
    const callNodes = collect(ctx.root, isCallExpression);

    for (const node of callNodes) {
      const callee = extractCallee(node);

      if (!matchCalleePattern(callee, pattern)) continue;

      results.push({
        callee,
        arguments: extractArguments(node),
        calleeFull: getFullCalleeText(node),
        line: node.startPosition.row + 1,
      });
    }

    return results;
  },
};

function extractCallee(node: import('web-tree-sitter').SyntaxNode): string {
  // The function child is the callee
  const funcNode = node.childForFieldName('function');
  if (funcNode) {
    // For simple calls like ref(), the callee is an identifier
    // For member calls like store.dispatch(), it's a member_expression
    if (funcNode.type === 'identifier') return funcNode.text;
    // For member expressions, return the property name
    if (funcNode.type === 'member_expression') {
      const prop = funcNode.childForFieldName('property');
      if (prop) return prop.text;
      return funcNode.text;
    }
    return funcNode.text;
  }
  return '';
}

function getFullCalleeText(node: import('web-tree-sitter').SyntaxNode): string {
  const funcNode = node.childForFieldName('function');
  return funcNode?.text ?? '';
}

function extractArguments(node: import('web-tree-sitter').SyntaxNode): string[] {
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

function matchCalleePattern(callee: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === callee) return true;

  // Glob-like matching: use*Store matches useFooStore, useBarStore
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(callee);
  }

  return false;
}
