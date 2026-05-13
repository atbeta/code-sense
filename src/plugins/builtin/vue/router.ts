import type { SyntaxNode } from 'web-tree-sitter';
import { collect } from '../../../engine/ast-traverser.js';

interface RouteEntry {
  path?: string;
  fullPath?: string;
  name?: string;
  component?: string;
  componentPath?: string;
  lazy?: boolean;
  redirect?: string;
  alias?: string[];
  meta?: Record<string, string>;
  guards?: string[];
  depth: number;
  children?: RouteEntry[];
}

export function detectRouter(root: SyntaxNode, props: Record<string, unknown>): void {
  const routeDefs = collect(
    root,
    (n) =>
      n.type === 'call_expression' &&
      (n.childForFieldName('function')?.text === 'createRouter' ||
        n.childForFieldName('function')?.text === 'new VueRouter'),
  );
  if (routeDefs.length > 0) {
    props.isRouter = true;
  }

  const routeEntries = extractRouteEntries(root);
  if (routeEntries.length > 0) {
    const flatRoutes = flattenRoutes(routeEntries);
    props.routes = flatRoutes;
    props.routeTree = routeEntries;
    props.routeCount = flatRoutes.length;
    props.hasNestedRoutes = flatRoutes.some((route) => route.depth > 0);
    props.hasRouteMeta = flatRoutes.some(
      (route) => route.meta && Object.keys(route.meta).length > 0,
    );
    props.hasRouteGuards = flatRoutes.some((route) => route.guards && route.guards.length > 0);
    props.hasRedirects = flatRoutes.some((route) => Boolean(route.redirect));
    props.hasAliases = flatRoutes.some((route) => Boolean(route.alias?.length));
  }
}

function extractRouteEntries(root: SyntaxNode): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const arrays = collect(root, (n) => n.type === 'array');

  for (const arr of arrays) {
    const entries = arr.namedChildren
      .filter((child) => child.type === 'object')
      .map((child) => parseRouteObject(child, '', 0))
      .filter((entry): entry is RouteEntry => Boolean(entry));

    if (entries.length > routes.length) {
      routes.splice(0, routes.length, ...entries);
    }
  }

  return routes;
}

function parseRouteObject(node: SyntaxNode, parentPath: string, depth: number): RouteEntry | null {
  const entry: RouteEntry = { depth };
  let children: RouteEntry[] = [];
  let hasRouteShape = false;

  for (const pair of node.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
    const value = pair.childForFieldName('value');
    if (!key || !value) continue;

    if (key === 'path') {
      entry.path = readString(value);
      entry.fullPath = buildFullPath(parentPath, entry.path);
      hasRouteShape = true;
    } else if (key === 'name') {
      entry.name = readString(value);
      hasRouteShape = true;
    } else if (key === 'component') {
      const component = readComponent(value);
      entry.component = component.display;
      entry.componentPath = component.path;
      entry.lazy = component.lazy;
      hasRouteShape = true;
    } else if (key === 'redirect') {
      entry.redirect = readString(value) ?? value.text;
      hasRouteShape = true;
    } else if (key === 'alias') {
      entry.alias = readStringArray(value);
      hasRouteShape = true;
    } else if (key === 'meta' && value.type === 'object') {
      entry.meta = readMetaObject(value);
      hasRouteShape = true;
    } else if (key === 'beforeEnter') {
      entry.guards = [value.text];
      hasRouteShape = true;
    } else if (key === 'children' && value.type === 'array') {
      children = value.namedChildren
        .filter((child) => child.type === 'object')
        .map((child) =>
          parseRouteObject(child, entry.fullPath ?? entry.path ?? parentPath, depth + 1),
        )
        .filter((child): child is RouteEntry => Boolean(child));
    }
  }

  if (children.length > 0) {
    entry.children = children;
    hasRouteShape = true;
  }

  if (!entry.fullPath && entry.path) {
    entry.fullPath = buildFullPath(parentPath, entry.path);
  }

  return hasRouteShape ? entry : null;
}

function flattenRoutes(routes: RouteEntry[]): RouteEntry[] {
  const flattened: RouteEntry[] = [];
  for (const route of routes) {
    const { children, ...flatRoute } = route;
    flattened.push(flatRoute);
    if (children?.length) flattened.push(...flattenRoutes(children));
  }
  return flattened;
}

function readComponent(value: SyntaxNode): { display?: string; path?: string; lazy?: boolean } {
  const importPath = extractImportPath(value.text);
  if (importPath) {
    return { display: value.text, path: importPath, lazy: true };
  }
  return { display: value.text, lazy: false };
}

function extractImportPath(text: string): string | undefined {
  const match = text.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  return match?.[1];
}

function readString(value: SyntaxNode): string | undefined {
  if (value.type !== 'string') return undefined;
  return value.text.replace(/^['"]|['"]$/g, '');
}

function readStringArray(value: SyntaxNode): string[] {
  if (value.type === 'string') {
    const item = readString(value);
    return item ? [item] : [];
  }
  if (value.type !== 'array') return [];
  return value.namedChildren
    .map((child) => readString(child))
    .filter((item): item is string => Boolean(item));
}

function readMetaObject(value: SyntaxNode): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const pair of value.namedChildren) {
    if (pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
    const val = pair.childForFieldName('value');
    if (!key || !val) continue;
    meta[key] = readString(val) ?? val.text;
  }
  return meta;
}

function buildFullPath(parentPath: string, path?: string): string | undefined {
  if (!path) return parentPath || undefined;
  if (path.startsWith('/')) return path;
  if (!parentPath || parentPath === '/') return `/${path}`;
  return `${parentPath.replace(/\/$/, '')}/${path}`;
}
