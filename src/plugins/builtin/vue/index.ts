/**
 * Vue Plugin for CodeSense
 *
 * Built-in plugin that provides Vue 3 framework detection and extraction:
 * - SFC parsing (.vue files)
 * - Composition API vs Options API detection
 * - Pinia / Vuex store internals (state, getters, actions, mutations)
 * - Composable function detection (useXxx)
 * - Vue Router integration
 * - Mixin detection (Options API mixins: [...])
 * - Compiler macro detection (defineProps, defineEmits, etc.)
 */
import type { CodeSensePlugin, DetectionResult, EntityExtractionContext } from '../../types.js';
import { detectVue } from './detect.js';
import { extractVueEntity } from './extractors.js';
import { classifyVueFunctions } from './classify.js';
import { postProcessMixins } from './postprocess.js';
import { VUE_ENTITIES, VUE_FRAMEWORK_APIS, VUE_RELATIONSHIPS } from './entities.js';

export const vuePlugin: CodeSensePlugin = {
  name: 'vue',
  description: 'Vue 3 SFC and Composition API support (includes Pinia, Vue Router, Mixins)',
  version: '0.2.2',

  detect(projectRoot: string): Promise<DetectionResult> | DetectionResult {
    return detectVue(projectRoot);
  },

  extractEntity(ctx: EntityExtractionContext) {
    return extractVueEntity(ctx);
  },

  classifyFunctions(ctx) {
    return classifyVueFunctions(ctx);
  },

  afterGraphBuilt(ctx) {
    return postProcessMixins(ctx);
  },
};

// Re-export for presets
export { VUE_ENTITIES, VUE_FRAMEWORK_APIS, VUE_RELATIONSHIPS };
