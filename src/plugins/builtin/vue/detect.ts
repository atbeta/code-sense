/**
 * Vue Plugin — Detection Rules
 * Checks package.json and file patterns to determine if this is a Vue project.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectionResult, DetectionSignal } from '../../types.js';
import { VUE_ENTITIES, VUE_FRAMEWORK_APIS, VUE_RELATIONSHIPS } from '../vue/entities.js';

export async function detectVue(projectRoot: string): Promise<DetectionResult> {
  const signals: DetectionSignal[] = [];

  // Check package.json for vue dependency
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps.vue) {
        signals.push({
          type: 'dependency',
          value: `vue@${deps.vue}`,
          description: 'vue dependency in package.json',
        });
      }
      if (deps.pinia) {
        signals.push({
          type: 'dependency',
          value: `pinia@${deps.pinia}`,
          description: 'pinia state management',
        });
      }
      if (deps['vue-router']) {
        signals.push({
          type: 'dependency',
          value: `vue-router@${deps['vue-router']}`,
          description: 'vue-router routing',
        });
      }
      if (deps.vuex) {
        signals.push({
          type: 'dependency',
          value: `vuex@${deps.vuex}`,
          description: 'vuex state management',
        });
      }
    } catch {
      // package.json may be invalid
    }
  }

  // If vue is a direct dependency, it's definitely a Vue project
  const hasVue = signals.some((s) => s.value.startsWith('vue@'));

  return {
    matched: hasVue,
    confidence: hasVue ? 1.0 : 0,
    signals,
    entities: hasVue ? VUE_ENTITIES : undefined,
    frameworkAPIs: hasVue ? VUE_FRAMEWORK_APIS : undefined,
    relationships: hasVue ? VUE_RELATIONSHIPS : undefined,
  };
}
