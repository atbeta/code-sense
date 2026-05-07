import type { Detector, DetectorContext, DetectorMatch } from './base.js';

/**
 * Extracts JSDoc-style annotations from comments.
 *
 * Looks for @tag: value or @tag value patterns in comments.
 *
 * Config params:
 *   tags: string[] - annotation tags to extract (e.g., ['chart-type', 'deprecated'])
 */
export const AnnotationDetector: Detector = {
  name: 'annotation',

  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[] {
    const tags = (params.tags as string[]) ?? ['*'];
    const results: DetectorMatch[] = [];

    // Match JSDoc comments and single-line // @tag comments
    const annotationRegex = /@(\w+)(?::\s*|\s+)(.+?)(?:\n|$|\*\/)/g;
    let match: RegExpExecArray | null;

    while ((match = annotationRegex.exec(ctx.source)) !== null) {
      const tag = match[1];
      const value = match[2].trim();

      if (tags.includes('*') || tags.includes(tag)) {
        results.push({ tag, value, offset: match.index });
      }
    }

    return results;
  },
};
