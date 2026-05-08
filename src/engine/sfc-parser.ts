/**
 * Regex-based Vue SFC parser.
 * Splits .vue files into template / script / style blocks without native dependencies.
 */
export interface SFCBlock {
  type: 'template' | 'script' | 'scriptSetup' | 'style' | 'unknown';
  content: string;
  startIndex: number;
  endIndex: number;
  attrs: string; // attributes on the opening tag
}

export interface ParsedSFC {
  filePath: string;
  blocks: SFCBlock[];
  usesScriptSetup: boolean;
  mainScript: SFCBlock | null;
}

// Matches <template>, <script ...>, <script setup ...>, <style ...> blocks
const BLOCK_RE = /<(\/?(template|script|style)\b)((?:\s[^>]*)?)>/gi;

export function parseSFC(source: string, filePath: string): ParsedSFC {
  const blocks: SFCBlock[] = [];
  let usesScriptSetup = false;

  // Track open/close positions for each block
  const openings: Array<{
    tag: string;
    position: number;
    fullMatch: string;
    attrs: string;
  }> = [];

  let match: RegExpExecArray | null;
  while ((match = BLOCK_RE.exec(source)) !== null) {
    const [fullMatch, , tag, attrs] = match;
    const isClosing = fullMatch.startsWith('</');

    if (isClosing) {
      // Find the matching opening tag
      for (let i = openings.length - 1; i >= 0; i--) {
        if (openings[i].tag === tag.toLowerCase()) {
          const open = openings[i];
          openings.splice(i, 1);

          const blockType = classifyBlock(tag, open.attrs);

          blocks.push({
            type: blockType,
            content: source.slice(open.position, match.index + fullMatch.length),
            startIndex: open.position,
            endIndex: match.index + fullMatch.length,
            attrs: open.attrs,
          });

          if (blockType === 'scriptSetup') usesScriptSetup = true;
          break;
        }
      }
    } else {
      openings.push({
        tag: tag.toLowerCase(),
        position: match.index,
        fullMatch,
        attrs: attrs ?? '',
      });
    }
  }

  const mainScript =
    blocks.find((b) => b.type === 'scriptSetup') ?? blocks.find((b) => b.type === 'script') ?? null;

  return {
    filePath,
    blocks,
    usesScriptSetup,
    mainScript,
  };
}

function classifyBlock(tag: string, attrs: string): SFCBlock['type'] {
  switch (tag.toLowerCase()) {
    case 'template':
      return 'template';
    case 'script':
      return attrs.includes('setup') ? 'scriptSetup' : 'script';
    case 'style':
      return 'style';
    default:
      return 'unknown';
  }
}

/**
 * Extract inner content of a script block (without the <script> tags).
 */
export function extractScriptContent(block: SFCBlock): string {
  const content = block.content;
  const openEnd = content.indexOf('>');
  if (openEnd === -1) return content;
  const closeStart = content.lastIndexOf('</');
  if (closeStart === -1) return content.slice(openEnd + 1);
  return content.slice(openEnd + 1, closeStart);
}
