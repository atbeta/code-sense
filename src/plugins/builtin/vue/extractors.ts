/**
 * Vue Plugin — Entity Extraction
 *
 * Extracts Vue-specific properties from source files:
 * - SFC script setup detection
 * - Options API vs Composition API
 * - Store internals (Pinia/Vuex state/getters/actions/mutations)
 * - Composable usage
 * - Component name
 * - Store variant
 * - Route entries
 */
import type { SyntaxNode } from 'web-tree-sitter';
import type { EntityExtractionContext, EntityExtractionResult } from '../../types.js';
import { parseSFC, extractScriptContent } from '../../../engine/sfc-parser.js';
import { parseSource, collect } from '../../../engine/ast-traverser.js';
import { extractMainIPC, extractRendererIPC, extractPreloadBridge } from './electron.js';
import { extractTemplateComponents } from './template.js';
import { detectRouter } from './router.js';
import {
  detectMapHelpers,
  detectStoreItemUsage,
  detectStoreUsage,
  extractStoreMetadata,
} from './store.js';

// ── Public API ──

export function extractVueEntity(ctx: EntityExtractionContext): EntityExtractionResult {
  const props: Record<string, unknown> = {};
  props.filePath = ctx.filePath; // needed for StoreItem primary key construction
  const apiUsage: EntityExtractionResult['apiUsage'] = [];
  const storeItems: EntityExtractionResult['storeItems'] = [];

  let astRoot = ctx.astRoot;
  let sfc: ReturnType<typeof parseSFC> | null;

  // SFC parsing for .vue files
  if (ctx.filePath.endsWith('.vue')) {
    sfc = parseSFC(ctx.source, ctx.filePath);
    props.isVue = true;
    props.usesScriptSetup = sfc.usesScriptSetup;

    if (sfc.mainScript) {
      const scriptLang =
        sfc.mainScript.attrs.includes('lang="ts"') || sfc.mainScript.attrs.includes("lang='ts'")
          ? ('ts' as const)
          : 'js';
      const scriptContent = extractScriptContent(sfc.mainScript);
      const tree = parseSource(scriptContent, scriptLang);
      astRoot = tree.rootNode;

      props.apiMode = detectApiMode(astRoot);
      extractComponentName(astRoot, props);
      detectStoreUsage(astRoot, props);
      detectStoreItemUsage(astRoot, props);
      detectMapHelpers(astRoot, props);
      detectComposableUsage(astRoot, props);
      detectMixins(astRoot, props);
      applyMarkers(props, sfc, ctx);
    }

    const template = sfc.blocks.find((b) => b.type === 'template');
    if (template) {
      const templateComponents = extractTemplateComponents(ctx.source, template);
      if (templateComponents.length > 0) {
        props.usesComponents = true;
        props.templateComponents = templateComponents;
      }
    }
  }

  // Framework API usage (works for both .vue and .js/.ts files)
  detectFrameworkApiUsage(astRoot, ctx, apiUsage);

  // Store internals (works for both .vue and .js/.ts store files)
  if (ctx.entityType === 'store') {
    extractStoreMetadata(astRoot, props, storeItems);
  }

  // Route file detection
  if (ctx.entityType === 'route') {
    detectRouter(astRoot, props);
  }

  // Electron main process: extract IPC handlers
  if (ctx.entityType === 'electron-main') {
    const handlers = extractMainIPC(astRoot);
    if (handlers.length > 0) {
      props.ipcHandlers = handlers;
      props.isElectronMain = true;
    }
  }

  // Preload script: extract bridge definition
  if (ctx.entityType === 'preload') {
    const bridge = extractPreloadBridge(astRoot);
    if (bridge) {
      props.preloadBridge = bridge;
      props.isPreload = true;
    }
  }

  // Components and renderer files: detect IPC calls
  if (ctx.entityType === 'component' || ctx.entityType === 'page' || ctx.entityType === 'layout') {
    const ipcCalls = extractRendererIPC(astRoot);
    if (ipcCalls.length > 0) {
      props.ipcCalls = ipcCalls;
      props.usesIPC = true;
    }
  }

  return { properties: props, apiUsage, storeItems };
}

// ── Detect API Mode ──

function detectApiMode(root: SyntaxNode): string {
  const compositionAPIs = ['ref', 'computed', 'watch', 'onMounted', 'reactive'];
  const hasSetup = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      compositionAPIs.includes(n.childForFieldName('function')?.text ?? ''),
  );
  const hasOptionsAPI = collect(
    root,
    (n) => n.type === 'export_statement' && n.text.includes('default'),
  );
  if (hasSetup.length > 0 && hasOptionsAPI.length > 0) return 'mixed';
  if (hasSetup.length > 0) return 'composition';
  if (hasOptionsAPI.length > 0) return 'options';
  return 'unknown';
}

// ── Component Name ──

function extractComponentName(root: SyntaxNode, props: Record<string, unknown>): void {
  const exportNodes = collect(
    root,
    (n) => n.type === 'export_statement' && n.text.includes('default'),
  );
  for (const node of exportNodes) {
    for (const child of node.namedChildren) {
      if (child.type === 'object' || child.type === 'object_literal') {
        for (const pair of child.namedChildren) {
          if (pair.type === 'pair') {
            const key = pair.childForFieldName('key');
            const value = pair.childForFieldName('value');
            if (key?.text === 'name' && value?.type === 'string') {
              const name = value.text.replace(/^['"]|['"]$/g, '');
              if (name) props.name = name;
              return;
            }
          }
        }
      }
    }
  }
}

// ── Composable Detection ──

function detectComposableUsage(root: SyntaxNode, props: Record<string, unknown>): void {
  const useCalls = collect(
    root,
    (n) =>
      n.type === 'call_expression' && /^use[A-Z]/.test(n.childForFieldName('function')?.text ?? ''),
  );
  if (useCalls.length > 0) {
    props.usesComposables = true;
    props.composableCalls = useCalls.map((n) => n.childForFieldName('function')?.text ?? '');
  }
}

// ── Mixin Detection ──

function detectMixins(root: SyntaxNode, props: Record<string, unknown>): void {
  const exportNodes = collect(
    root,
    (n) => n.type === 'export_statement' && n.text.includes('default'),
  );
  for (const node of exportNodes) {
    for (const obj of collect(node, (n) => n.type === 'object' || n.type === 'object_literal')) {
      for (const pair of obj.namedChildren) {
        if (pair.type !== 'pair') continue;
        const key = pair.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
        if (key !== 'mixins') continue;
        const value = pair.childForFieldName('value');
        if (!value || value.type !== 'array') continue;

        const mixinNames: string[] = [];
        for (const elem of value.namedChildren) {
          if (elem.type === 'identifier') {
            mixinNames.push(elem.text);
          }
        }
        if (mixinNames.length > 0) {
          props.usesMixins = true;
          props.mixinNames = mixinNames;
        }
      }
    }
  }
}

// ── Framework API Detection ──

function detectFrameworkApiUsage(
  astRoot: SyntaxNode,
  ctx: EntityExtractionContext,
  apiUsage: EntityExtractionResult['apiUsage'],
): void {
  const config = ctx.config;
  if (!config.framework_apis?.length) return;

  // Build framework API map
  const frameworkAPIMap = new Map<string, string>();
  for (const fw of config.framework_apis) {
    for (const api of fw.api_list) {
      frameworkAPIMap.set(api, fw.name);
    }
  }

  const callNodes = collect(astRoot, (n) => n.type === 'call_expression');
  for (const node of callNodes) {
    const funcName = node.childForFieldName('function')?.text ?? '';
    if (frameworkAPIMap.has(funcName)) {
      apiUsage.push({
        fromFile: ctx.filePath,
        apiName: funcName,
        frameworkName: frameworkAPIMap.get(funcName)!,
      });
    }
  }

  // Compiler macros
  for (const fw of config.framework_apis) {
    if (fw.compiler_macros) {
      for (const macro of fw.compiler_macros) {
        const macroNodes = collect(
          astRoot,
          (n) => n.type === 'call_expression' && n.childForFieldName('function')?.text === macro,
        );
        for (const _ of macroNodes) {
          apiUsage.push({
            fromFile: ctx.filePath,
            apiName: macro,
            frameworkName: fw.name,
          });
        }
      }
    }
  }
}

// ── Entity Marker Application ──

function applyMarkers(
  props: Record<string, unknown>,
  sfc: ReturnType<typeof parseSFC> | null,
  ctx: EntityExtractionContext,
): void {
  const entityDef = ctx.config.all_entities[ctx.entityType];
  if (!entityDef?.markers) return;

  for (const marker of entityDef.markers) {
    if (marker.uses_options_api !== undefined && sfc) {
      props.usesOptionsAPI = marker.uses_options_api;
      const scriptContent = sfc.mainScript ? extractScriptContent(sfc.mainScript) : '';
      const scriptLang =
        sfc.mainScript?.attrs.includes('lang="ts"') || sfc.mainScript?.attrs.includes("lang='ts'")
          ? ('ts' as const)
          : 'js';
      const isOptions =
        detectApiMode(parseSource(scriptContent, scriptLang).rootNode) === 'options';
      if (marker.uses_options_api && isOptions) {
        props.markedAsOptionsAPI = true;
      }
    }
    if (marker.naming_pattern) {
      const name = (props.name as string) ?? '';
      const regex = new RegExp('^' + marker.naming_pattern.replace(/\*/g, '.*') + '$');
      props.matchesNamingPattern = regex.test(name);
    }
  }
}
