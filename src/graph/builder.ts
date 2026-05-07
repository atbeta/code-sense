import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { SyntaxNode } from 'web-tree-sitter';
import type { ResolvedConfig } from '../types/config.js';
import type { EntityInstance, RelationInstance } from '../types/graph.js';
import { scanFiles } from '../engine/file-scanner.js';
import { parseSFC, extractScriptContent } from '../engine/sfc-parser.js';
import {
  initParser,
  parseSource,
  collect,
  isImportStatement,
} from '../engine/ast-traverser.js';
import { getDetector } from '../engine/detectors/index.js';
import type { DetectorContext } from '../engine/detectors/base.js';
import { LbugGraph } from './lbug.js';
import { createSchema } from './schema.js';

export interface BuildResult {
  entities: EntityInstance[];
  relations: RelationInstance[];
  nodeCount: number;
  edgeCount: number;
}

export async function buildGraph(
  config: ResolvedConfig,
  sourceRoot: string,
  dbPath: string,
): Promise<BuildResult> {
  await initParser();

  const graph = new LbugGraph(dbPath);
  await createSchema(graph, config);

  const scanned = await scanFiles(config, sourceRoot);

  const entities: EntityInstance[] = [];

  for (const file of scanned) {
    const entity = await processFile(
      file.filePath,
      file.entityType,
    );
    if (entity) {
      entities.push(entity);

      await graph.upsertEntity(
        (entity.properties.name as string) ??
          basename(entity.filePath, extname(entity.filePath)),
        entity.filePath,
        entity.type,
        entity.properties,
      );
    }
  }

  const relations: RelationInstance[] = [];

  // Auto-detected imports
  const importEdges = await buildImportEdges(entities, sourceRoot);
  for (const edge of importEdges) {
    relations.push(edge);
    try {
      await graph.createRel(
        edge.fromId,
        edge.toId,
        edge.type,
        edge.properties,
      );
    } catch {
      // target may not exist
    }
  }

  // Config-defined relationships
  for (const [relType, relDef] of Object.entries(config.relationships ?? {})) {
    if (relType === 'imports') continue;

    const relEdges = await buildRelationshipEdges(
      relType,
      relDef,
      entities,
      config,
    );
    for (const edge of relEdges) {
      relations.push(edge);
      try {
        await graph.createRel(
          edge.fromId,
          edge.toId,
          edge.type,
          edge.properties,
        );
      } catch {
        // target may not exist
      }
    }
  }

  await graph.close();

  return {
    entities,
    relations,
    nodeCount: entities.length,
    edgeCount: relations.length,
  };
}

async function processFile(
  filePath: string,
  entityType: string,
): Promise<EntityInstance | null> {
  const source = readFileSync(filePath, 'utf-8');
  const props: Record<string, unknown> = {};

  if (filePath.endsWith('.vue')) {
    const sfc = parseSFC(source, filePath);
    props.isVue = true;
    props.usesScriptSetup = sfc.usesScriptSetup;

    if (sfc.mainScript) {
      const scriptContent = extractScriptContent(sfc.mainScript);
      const tree = parseSource(scriptContent);
      const root = tree.rootNode;

      props.apiMode = detectApiMode(root);

      extractComponentName(root, props);

      const storeCalls = collect(
        root,
        (n) =>
          n.type === 'call_expression' &&
          (n.childForFieldName('function')?.text?.startsWith('use') ?? false),
      );
      if (storeCalls.length > 0) {
        props.usesStore = true;
        props.storeCalls = storeCalls.map(
          (n) => n.childForFieldName('function')?.text ?? '',
        );
      }

      const mapCalls = collect(
        root,
        (n) =>
          n.type === 'call_expression' &&
          [
            'mapState',
            'mapActions',
            'mapGetters',
            'mapMutations',
          ].includes(n.childForFieldName('function')?.text ?? ''),
      );
      if (mapCalls.length > 0) {
        props.usesMapHelpers = true;
        props.mapHelperCalls = mapCalls.map((n) => ({
          helper: n.childForFieldName('function')?.text ?? '',
          args: n.childForFieldName('arguments')?.text ?? '',
        }));
      }
    }
  }

  // Extract imports for relationship building
  let astRoot: SyntaxNode;
  if (filePath.endsWith('.vue')) {
    const sfc = parseSFC(source, filePath);
    const block = sfc.mainScript;
    const code = block ? extractScriptContent(block) : '';
    astRoot = parseSource(code).rootNode;
  } else {
    astRoot = parseSource(source).rootNode;
  }

  const imports = extractImports(astRoot);
  if (imports.length > 0) {
    props._imports = imports;
  }

  // Auto-detect store variants
  if (entityType === 'store') {
    const defineStoreCalls = collect(
      astRoot,
      (n) =>
        n.type === 'call_expression' &&
        n.childForFieldName('function')?.text === 'defineStore',
    );
    if (defineStoreCalls.length > 0) {
      props.variant = 'pinia';
    }

    const vuexStores = collect(
      astRoot,
      (n) =>
        n.type === 'new_expression' &&
        n.text.includes('Store'),
    );
    if (vuexStores.length > 0) {
      props.variant = 'vuex';
    }
  }

  // Auto-detect route files
  if (entityType === 'route') {
    const routeDefs = collect(
      astRoot,
      (n) =>
        n.type === 'call_expression' &&
        (n.childForFieldName('function')?.text === 'createRouter' ||
         n.childForFieldName('function')?.text === 'new VueRouter'),
    );
    if (routeDefs.length > 0) {
      props.isRouter = true;
    }
  }

  return {
    type: entityType,
    id: filePath,
    filePath,
    properties: props,
  };
}

function detectApiMode(root: SyntaxNode): string {
  const compositionAPIs = [
    'ref', 'computed', 'watch', 'onMounted', 'reactive',
  ];
  const hasSetup = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      compositionAPIs.includes(
        n.childForFieldName('function')?.text ?? '',
      ),
  );

  const hasOptionsAPI = collect(
    root,
    (n) =>
      n.type === 'export_statement' && n.text.includes('default'),
  );

  if (hasSetup.length > 0 && hasOptionsAPI.length > 0) return 'mixed';
  if (hasSetup.length > 0) return 'composition';
  if (hasOptionsAPI.length > 0) return 'options';
  return 'unknown';
}

function extractComponentName(
  root: SyntaxNode,
  props: Record<string, unknown>,
): void {
  const exportNodes = collect(
    root,
    (n) =>
      n.type === 'export_statement' && n.text.includes('default'),
  );

  for (const node of exportNodes) {
    for (const child of node.namedChildren) {
      if (child.type === 'object' || child.type === 'object_literal') {
        for (const pair of child.namedChildren) {
          if (pair.type === 'pair') {
            const key = pair.childForFieldName('key');
            const value = pair.childForFieldName('value');
            if (key?.text === 'name' && value?.type === 'string') {
              props.name = value.text.replace(/^['"]|['"]$/g, '');
            }
          }
        }
      }
    }
  }
}

interface ImportInfo {
  source: string;
  imports: string[];
  isDefault: boolean;
}

function extractImports(root: SyntaxNode): ImportInfo[] {
  const importNodes = collect(root, isImportStatement);
  const results: ImportInfo[] = [];

  for (const node of importNodes) {
    let source = '';
    const names: string[] = [];

    for (const child of node.namedChildren) {
      if (child.type === 'string') {
        source = child.text.replace(/^['"]|['"]$/g, '');
      } else if (child.type === 'import_specifier') {
        for (const spec of child.namedChildren) {
          if (spec.type === 'identifier') names.push(spec.text);
        }
      } else if (child.type === 'identifier') {
        names.push(child.text);
      }
    }

    results.push({
      source,
      imports: names,
      isDefault: node.text.includes('import ') && !node.text.includes('{'),
    });
  }

  return results;
}

async function buildImportEdges(
  entities: EntityInstance[],
  sourceRoot: string,
): Promise<RelationInstance[]> {
  const relations: RelationInstance[] = [];
  const entityFiles = new Set(entities.map((e) => e.filePath));

  for (const entity of entities) {
    const imports = entity.properties._imports as ImportInfo[] | undefined;
    if (!imports) continue;

    for (const imp of imports) {
      const resolved = resolveImportPath(
        entity.filePath,
        imp.source,
        sourceRoot,
      );
      if (resolved && entityFiles.has(resolved)) {
        relations.push({
          type: 'imports',
          fromId: entity.filePath,
          toId: resolved,
          properties: { importedNames: imp.imports },
        });
      }
    }
  }

  return relations;
}

function resolveImportPath(
  fromFile: string,
  importSource: string,
  sourceRoot: string,
): string | null {
  if (importSource.startsWith('.')) {
    const dir = fromFile.substring(0, fromFile.lastIndexOf('/'));
    const resolvedPath = resolve(dir, importSource);
    for (const ext of [
      '', '.vue', '.ts', '.js', '.jsx', '.tsx', '/index.ts', '/index.js', '/index.vue',
    ]) {
      try {
        readFileSync(resolvedPath + ext);
        return resolvedPath + ext;
      } catch {
        // not found
      }
    }
    return null;
  }

  if (importSource.startsWith('@/')) {
    const relative = importSource.slice(2);
    const resolvedPath = resolve(sourceRoot, relative);
    for (const ext of [
      '', '.vue', '.ts', '.js', '.jsx', '.tsx', '/index.ts', '/index.js', '/index.vue',
    ]) {
      try {
        readFileSync(resolvedPath + ext);
        return resolvedPath + ext;
      } catch {
        // not found
      }
    }
    return null;
  }

  return null;
}

async function buildRelationshipEdges(
  relType: string,
  relDef: import('../types/config.js').RelationshipDefinition,
  entities: EntityInstance[],
  _config: ResolvedConfig,
): Promise<RelationInstance[]> {
  const relations: RelationInstance[] = [];
  const fromEntities = entities.filter((e) => e.type === relDef.from);
  const toEntities = entities.filter((e) => e.type === relDef.to);

  if (fromEntities.length === 0 || toEntities.length === 0) return [];

  const detectors = relDef.detect_by ?? [];
  if (detectors.length === 0 && relDef.detector) {
    detectors.push({ type: relDef.detector });
  }

  for (const fromEntity of fromEntities) {
    const source = readFileSync(fromEntity.filePath, 'utf-8');
    const sfc = fromEntity.filePath.endsWith('.vue')
      ? parseSFC(source, fromEntity.filePath)
      : null;

    for (const detectCfg of detectors) {
      const detector = getDetector(detectCfg.type);
      if (!detector) continue;

      let astRoot: SyntaxNode;
      if (sfc?.mainScript) {
        const code = extractScriptContent(sfc.mainScript);
        astRoot = parseSource(code).rootNode;
      } else {
        astRoot = parseSource(source).rootNode;
      }

      const ctx: DetectorContext = {
        source,
        root: astRoot,
        templateContent: sfc?.blocks.find((b) => b.type === 'template')
          ?.content,
        scriptContent: sfc?.mainScript?.content,
      };

      const matches = detector.detect(ctx, {
        pattern: detectCfg.pattern,
      });
      for (const match of matches) {
        for (const toEntity of toEntities) {
          if (
            matchMatchesEntity(
              match,
              toEntity,
              detectCfg.type,
            )
          ) {
            relations.push({
              type: relType,
              fromId: fromEntity.filePath,
              toId: toEntity.filePath,
              properties: match,
            });
          }
        }
      }
    }
  }

  return relations;
}

function matchMatchesEntity(
  match: Record<string, unknown>,
  entity: EntityInstance,
  detectorType: string,
): boolean {
  const entityName = (entity.properties.name as string) ?? '';
  const entityPath = entity.filePath;

  if (detectorType === 'call_expression') {
    const callee = String(match.callee ?? '');
    if (
      callee
        .toLowerCase()
        .includes(entityName.toLowerCase().replace(/[^a-zA-Z0-9]/g, ''))
    ) {
      return true;
    }
    if (
      entityPath.toLowerCase().includes(
        callee.replace('use', '').replace(/Store$/i, '').toLowerCase(),
      )
    ) {
      return true;
    }
  }

  if (detectorType === 'member_expression') {
    return entity.type.toLowerCase().includes('store');
  }

  return false;
}
