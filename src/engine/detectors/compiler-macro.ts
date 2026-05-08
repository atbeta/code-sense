import { collect } from '../ast-traverser.js';
import type { Detector, DetectorContext, DetectorMatch } from './base.js';

/**
 * Detects Vue 3 compiler macros in <script setup>:
 *   defineProps, defineEmits, defineExpose, defineOptions, withDefaults
 *
 * Config params:
 *   macros: string[] - macro names to detect (e.g., ['defineProps', 'defineEmits'])
 */
export const CompilerMacroDetector: Detector = {
  name: 'compiler_macro',

  detect(ctx: DetectorContext, params: Record<string, unknown>): DetectorMatch[] {
    const macros = (params.macros as string[]) ?? [
      'defineProps',
      'defineEmits',
      'defineExpose',
      'defineOptions',
      'withDefaults',
    ];
    const results: DetectorMatch[] = [];

    const callNodes = collect(
      ctx.root,
      (node) =>
        node.type === 'call_expression' &&
        macros.includes(node.childForFieldName('function')?.text ?? ''),
    );

    for (const node of callNodes) {
      const macroName = node.childForFieldName('function')?.text ?? '';
      const args = node.childForFieldName('arguments');

      results.push({
        macro: macroName,
        arguments: args?.text ?? '',
        line: node.startPosition.row + 1,
      });
    }

    return results;
  },
};
