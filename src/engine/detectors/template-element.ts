import type { Detector, DetectorContext, DetectorMatch } from './base.js';

/**
 * Detects specific HTML elements or patterns in the template block.
 *
 * Config params:
 *   contains: string[] - substrings to search for in template (e.g., ['<svg', '<canvas'])
 */
export const TemplateElementDetector: Detector = {
  name: 'template_element',

  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[] {
    const contains = (params.contains as string[]) ?? [];
    if (!ctx.templateContent || contains.length === 0) return [];

    const results: DetectorMatch[] = [];

    for (const pattern of contains) {
      if (ctx.templateContent.includes(pattern)) {
        // Count occurrences
        const count = ctx.templateContent.split(pattern).length - 1;
        results.push({ matched: pattern, count });
      }
    }

    // If no specific patterns, return all top-level template elements
    if (contains.length === 0) {
      // Simple regex to find component-style tags (PascalCase)
      const pascalTagRegex = /<([A-Z][a-zA-Z0-9]*)/g;
      const tags = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = pascalTagRegex.exec(ctx.templateContent)) !== null) {
        tags.add(m[1]);
      }
      for (const tag of tags) {
        results.push({ tag, isComponent: true });
      }
    }

    return results;
  },
};
