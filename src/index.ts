#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { loadConfig, resolveSourceRoot } from './config/loader.js';
import { createInitConfig, probeProject } from './config/init.js';
import { buildGraph } from './graph/builder.js';
import { startMCPServer } from './mcp/server.js';
import { startVisServer } from './vis/server.js';
import { getRegistry, resetRegistry } from './plugins/registry.js';
import { vuePlugin } from './plugins/builtin/vue/index.js';

const program = new Command();

program
  .name('code-sense')
  .description('Config-driven code knowledge graph for Vue projects')
  .version('0.1.0');

program
  .command('index')
  .description('Build the code knowledge graph for a project')
  .option('-c, --config <path>', 'Path to codesense.yaml', 'codesense.yaml')
  .option('-o, --output <path>', 'Output path for the KuzuDB graph', '.code-sense/graph')
  .action(async (options) => {
    const configPath = resolve(process.cwd(), options.config);
    const outputPath = resolve(process.cwd(), options.output);

    console.error(`[CodeSense] Loading config: ${configPath}`);
    const config = loadConfig(configPath);
    const sourceRoot = resolveSourceRoot(config, process.cwd());

    // ── Bootstrap plugins ──
    resetRegistry();
    const registry = getRegistry();
    // Register built-in plugins (always registered, only activated if detected)
    registry.register(vuePlugin);
    // TODO: support codesense.yaml `plugins:` field for external plugins

    console.error(`[CodeSense] Project: ${config.project.name}`);
    console.error(`[CodeSense] Source root: ${sourceRoot}`);
    console.error(`[CodeSense] Entity types: ${Object.keys(config.all_entities).join(', ')}`);
    console.error(`[CodeSense] Building graph...`);

    const startTime = Date.now();
    const result = await buildGraph(config, sourceRoot, outputPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.error(`[CodeSense] Done in ${elapsed}s`);
    console.log(
      JSON.stringify(
        {
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          entityTypes: Object.keys(config.all_entities),
          outputPath,
        },
        null,
        2,
      ),
    );
  });

program
  .command('serve')
  .description('Start the MCP server (stdio by default, HTTP with --port)')
  .option('-c, --config <path>', 'Path to codesense.yaml', 'codesense.yaml')
  .option('-o, --output <path>', 'Path to the KuzuDB graph', '.code-sense/graph')
  .option('-p, --port <number>', 'Run as HTTP server on the given port', parseInt)
  .action(async (options) => {
    const configPath = resolve(process.cwd(), options.config);
    const outputPath = resolve(process.cwd(), options.output);

    await startMCPServer(configPath, outputPath, options.port);
  });

program
  .command('view')
  .description('Start the graph visualization server')
  .option('-o, --output <path>', 'Path to the graph database', '.code-sense/graph')
  .option('-p, --port <number>', 'HTTP server port', '3456')
  .action(async (options) => {
    const outputPath = resolve(process.cwd(), options.output);
    const port = parseInt(options.port, 10);
    await startVisServer(outputPath, port);
    console.error(`[CodeSense] Press Ctrl+C to stop`);
  });

program
  .command('init')
  .description('Create a default codesense.yaml in the current directory')
  .option('-i, --interactive', 'Ask questions and generate a fuller Vue/Electron config')
  .option('-f, --file <path>', 'Config file to create', 'codesense.yaml')
  .action(async (options) => {
    const cwd = process.cwd();
    const targetPath = resolve(cwd, options.file);
    if (existsSync(targetPath)) {
      console.error(`Config already exists at ${targetPath}`);
      process.exit(1);
    }

    const config = await createInitConfig(cwd, Boolean(options.interactive));
    writeFileSync(targetPath, config, 'utf-8');

    const probe = probeProject(cwd);
    console.log(`Created ${options.file} at ${targetPath}`);
    console.error(`[CodeSense] Detected source root: ${probe.sourceRoot}`);
    console.error(`[CodeSense] Detected file extension: .${probe.extension}`);
    if (options.interactive) {
      console.error(
        '[CodeSense] Generated interactive config with framework APIs and relationships.',
      );
    }
  });

program.parse();
