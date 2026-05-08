import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CodeSenseConfig, ResolvedConfig } from '../types/config.js';

export function loadConfig(configPath?: string): ResolvedConfig {
  const path = configPath ?? resolve(process.cwd(), 'codesense.yaml');

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw new Error(`Config file not found at ${path}. Run 'codesense init' to create one.`);
  }

  const parsed = parseYaml(raw) as CodeSenseConfig;

  if (!parsed.project?.name || !parsed.project?.source_root) {
    throw new Error('Config must define project.name and project.source_root');
  }

  // Merge entities and custom_entities into all_entities
  const all_entities = {
    ...parsed.entities,
    ...parsed.custom_entities,
  };

  const resolved: ResolvedConfig = {
    ...parsed,
    all_entities,
    framework_apis: parsed.framework_apis ?? [],
    relationships: parsed.relationships ?? {},
  };

  return resolved;
}

export function resolveSourceRoot(config: ResolvedConfig, configDir: string): string {
  if (
    config.project.source_root.startsWith('/') ||
    /^([a-zA-Z]:\\)/.test(config.project.source_root)
  ) {
    return config.project.source_root;
  }
  return resolve(configDir, config.project.source_root);
}
