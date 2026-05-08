import { collect, isMemberExpression } from '../ast-traverser.js';
import type { Detector, DetectorContext, DetectorMatch } from './base.js';

/**
 * Detects member access expressions like this.$store.dispatch(...).
 *
 * Config params:
 *   pattern: string - pattern to match the full member path (e.g., '*.dispatch', '$store.*')
 */
export const MemberExpressionDetector: Detector = {
  name: 'member_expression',

  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[] {
    const pattern = params.pattern as string;
    if (!pattern) return [];

    const results: DetectorMatch[] = [];
    const memberNodes = collect(ctx.root, isMemberExpression);

    for (const node of memberNodes) {
      const fullPath = node.text;

      if (!matchPattern(fullPath, pattern)) continue;

      const object = node.childForFieldName('object');
      const property = node.childForFieldName('property');

      results.push({
        object: object?.text ?? '',
        property: property?.text ?? '',
        fullPath,
        line: node.startPosition.row + 1,
      });
    }

    return results;
  },
};

function matchPattern(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (value === pattern) return true;
  if (pattern.includes('*')) {
    const regex = new RegExp(
      '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$',
    );
    return regex.test(value);
  }
  return value.includes(pattern);
}
