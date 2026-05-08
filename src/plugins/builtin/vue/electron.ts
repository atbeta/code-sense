/**
 * Vue Plugin — Electron IPC Extraction
 *
 * Detects Electron IPC patterns across main, preload, and renderer processes:
 * - ipcMain.handle / ipcMain.on (main process)
 * - contextBridge.exposeInMainWorld (preload)
 * - ipcRenderer.invoke / ipcRenderer.send (renderer)
 * - window.api.* / window.electronAPI.* (renderer via preload)
 */
import type { SyntaxNode } from 'web-tree-sitter';
import { collect } from '../../../engine/ast-traverser.js';

export interface IPCHandler {
  channel: string;
  handlerName: string;
  line: number;
  type: 'handle' | 'on';
}

export interface IPCCall {
  channel: string;
  callee: string;
  line: number;
  type: 'invoke' | 'send' | 'preloadBridge';
}

export interface PreloadBridge {
  namespace: string;
  methods: string[];
  line: number;
}

/** Extract IPC handler registrations from Electron main process */
export function extractMainIPC(root: SyntaxNode): IPCHandler[] {
  const handlers: IPCHandler[] = [];
  const calls = collect(root, (n) => n.type === 'call_expression');

  for (const call of calls) {
    const callee = getFullCallee(call);
    if (!callee) continue;

    const isHandle = callee === 'ipcMain.handle';
    const isOn = callee === 'ipcMain.on';
    if (!isHandle && !isOn) continue;

    const args = call.childForFieldName('arguments');
    if (!args) continue;

    const argList = args.namedChildren.filter((c) => c.type !== ',' && c.type !== '(' && c.type !== ')');
    const channel = argList[0]?.text?.replace(/^['"]|['"]$/g, '') ?? '';
    const handlerName = argList[1]?.type === 'identifier'
      ? argList[1].text
      : argList[1]?.type === 'arrow_function'
        ? '(inline)'
        : '';

    if (channel) {
      handlers.push({
        channel,
        handlerName,
        line: call.startPosition.row + 1,
        type: isHandle ? 'handle' : 'on',
      });
    }
  }

  return handlers;
}

/** Extract IPC calls from renderer process (.vue / .ts files) */
export function extractRendererIPC(root: SyntaxNode): IPCCall[] {
  const calls: IPCCall[] = [];
  const allCalls = collect(root, (n) => n.type === 'call_expression');

  for (const call of allCalls) {
    const callee = getFullCallee(call);
    if (!callee) continue;

    // ipcRenderer.invoke('channel', ...)
    if (callee === 'ipcRenderer.invoke') {
      const args = call.childForFieldName('arguments');
      const channel = args?.namedChildren[0]?.text?.replace(/^['"]|['"]$/g, '') ?? '';
      if (channel) {
        calls.push({ channel, callee, line: call.startPosition.row + 1, type: 'invoke' });
      }
    }
    // ipcRenderer.send('channel', ...)
    if (callee === 'ipcRenderer.send') {
      const args = call.childForFieldName('arguments');
      const channel = args?.namedChildren[0]?.text?.replace(/^['"]|['"]$/g, '') ?? '';
      if (channel) {
        calls.push({ channel, callee, line: call.startPosition.row + 1, type: 'send' });
      }
    }
    // window.api.xxx() or window.electronAPI.xxx()
    if (callee.startsWith('window.api.') || callee.startsWith('window.electronAPI.')) {
      const parts = callee.split('.');
      if (parts.length === 3) {
        calls.push({ channel: parts[2], callee, line: call.startPosition.row + 1, type: 'preloadBridge' });
      }
    }
  }

  return calls;
}

/** Extract preload bridge definitions */
export function extractPreloadBridge(root: SyntaxNode): PreloadBridge | null {
  const calls = collect(root, (n) => n.type === 'call_expression');

  for (const call of calls) {
    const callee = getFullCallee(call);
    if (!callee) continue;
    if (callee !== 'contextBridge.exposeInMainWorld' && !callee.endsWith('.exposeInMainWorld')) continue;

    const args = call.childForFieldName('arguments');
    if (!args) continue;

    const argList = args.namedChildren.filter((c) => c.type !== ',' && c.type !== '(' && c.type !== ')');
    // First arg: 'api' or 'electronAPI' — the namespace string
    const namespace = argList[0]?.text?.replace(/^['"]|['"]$/g, '') ?? '';
    // Second arg: the object with methods
    const methods: string[] = [];
    const objArg = argList[1];
    if (objArg?.type === 'object' || objArg?.type === 'object_literal') {
      for (const pair of objArg.namedChildren) {
        if (pair.type === 'pair') {
          const key = pair.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
          if (key) methods.push(key);
        }
        if (pair.type === 'shorthand_property_identifier') {
          methods.push(pair.text);
        }
      }
    }

    if (namespace) {
      return {
        namespace,
        methods,
        line: call.startPosition.row + 1,
      };
    }
  }

  return null;
}

function getFullCallee(call: SyntaxNode): string | null {
  const func = call.childForFieldName('function');
  if (!func) return null;
  if (func.type === 'identifier') return func.text;
  if (func.type === 'member_expression') {
    const obj = func.childForFieldName('object');
    const prop = func.childForFieldName('property');
    if (obj && prop) {
      const objText = getFullCalleeText(obj);
      return objText ? `${objText}.${prop.text}` : prop.text;
    }
  }
  return null;
}

function getFullCalleeText(node: SyntaxNode): string {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    if (obj && prop) {
      const objText = getFullCalleeText(obj);
      return objText ? `${objText}.${prop.text}` : prop.text;
    }
  }
  return node.text;
}
