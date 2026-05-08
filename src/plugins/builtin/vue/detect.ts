/**
 * Vue Plugin — Detection Rules
 * Checks package.json and file patterns to determine if this is a Vue project.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
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
      if (deps.electron || deps['electron-builder']) {
        signals.push({
          type: 'dependency',
          value: `electron@${deps.electron || deps['electron-builder']}`,
          description: 'electron desktop app',
        });
      }
    } catch {
      // package.json may be invalid
    }
  }

  // If vue is a direct dependency, it's definitely a Vue project
  const hasVueInPackage = signals.some((s) => s.value.startsWith('vue@'));

  // Fallback: check for .vue files in the project (even without vue in package.json)
  let hasVueFiles = false;
  if (!hasVueInPackage) {
    try {
      const vueFiles = await fg('**/*.vue', {
        cwd: projectRoot,
        ignore: ['node_modules/**'],
        onlyFiles: true,
        deep: 2,
      });
      if (vueFiles.length > 0) {
        hasVueFiles = true;
        signals.push({
          type: 'file_pattern',
          value: `${vueFiles.length} .vue files found`,
          description: 'Vue SFC files detected in project',
        });
      }
    } catch {
      // glob may fail
    }
  }

  const matched = hasVueInPackage || hasVueFiles;

  return {
    matched,
    confidence: hasVueInPackage ? 1.0 : hasVueFiles ? 0.7 : 0,
    signals,
    entities: matched ? VUE_ENTITIES : undefined,
    frameworkAPIs: matched ? VUE_FRAMEWORK_APIS : undefined,
    relationships: matched ? VUE_RELATIONSHIPS : undefined,
  };
}
