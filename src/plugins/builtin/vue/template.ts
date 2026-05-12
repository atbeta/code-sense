import type { SFCBlock } from '../../../engine/sfc-parser.js';

export interface TemplateComponentUsage {
  tag: string;
  line: number;
}

const VUE_BUILTIN_TEMPLATE_TAGS = new Set([
  'component',
  'keep-alive',
  'router-link',
  'router-view',
  'slot',
  'suspense',
  'teleport',
  'transition',
  'transition-group',
]);

export function extractTemplateComponents(
  source: string,
  template: SFCBlock,
): TemplateComponentUsage[] {
  const tags = new Map<string, number>();
  const tagRe = /<\s*([A-Za-z][A-Za-z0-9_.:-]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(template.content)) !== null) {
    const rawTag = match[1];
    const tag = rawTag.includes(':') ? rawTag.split(':').pop()! : rawTag;
    if (!isLikelyVueComponentTag(tag)) continue;
    if (!tags.has(tag)) {
      tags.set(tag, lineForIndex(source, template.startIndex + match.index));
    }
  }

  return [...tags.entries()].map(([tag, line]) => ({ tag, line }));
}

function isLikelyVueComponentTag(tag: string): boolean {
  const normalized = tag.toLowerCase();
  if (VUE_BUILTIN_TEMPLATE_TAGS.has(normalized)) return false;
  return /^[A-Z]/.test(tag) || tag.includes('-');
}

function lineForIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}
