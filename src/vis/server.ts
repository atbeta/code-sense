import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LbugGraph } from '../graph/lbug.js';
import { graphToVis } from './adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveModuleFile(modulePath: string): string {
  // package root = dist/vis/../.. = @code-sense/core/
  const pkgRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    // Package-local node_modules (npm install)
    path.resolve(pkgRoot, 'node_modules', modulePath),
    // Hoisted to parent (npx cache)
    path.resolve(pkgRoot, '..', '..', modulePath),
    // User's project node_modules (global install)
    path.resolve(process.cwd(), 'node_modules', modulePath),
  ];
  for (const p of candidates) {
    try {
      statSync(p);
      return p;
    } catch {
      /* not found */
    }
  }
  return candidates[0];
}

const MIME: Record<string, string> = {
  '.js': 'application/javascript',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSense — Knowledge Graph</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap');
  :root {
    --bg: #0a0c10;
    --surface: #12151b;
    --surface-raised: #1a1e26;
    --border: #2a3040;
    --border-light: #353d4e;
    --text: #e1e4e8;
    --text-secondary: #aeb5c0;
    --muted: #6e7681;
    --blue: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --purple: #a371f7;
    --red: #f85149;
    --orange: #f0883e;
    --cyan: #39d2c0;
    --pink: #db61a2;
    --lime: #a5d6a7;
    --teal: #4db6ac;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font:13px/1.5 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; overflow:hidden; -webkit-font-smoothing:antialiased; }
  #canvas { position:absolute; inset:0; background:var(--bg); }

  /* Top Bar */
  #topbar {
    position:absolute; top:0; left:0; right:0; z-index:10;
    display:flex; align-items:center; gap:6px; padding:6px 12px;
    background:var(--surface); border-bottom:1px solid var(--border);
    backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  }
  #topbar .search-wrap {
    position:relative; flex:1; max-width:360px; min-width:180px;
  }
  #topbar input {
    width:100%; padding:5px 74px 5px 12px; border:1px solid var(--border);
    border-radius:6px; background:var(--bg); color:var(--text); font-size:12px; outline:none;
    font-family:'Inter',sans-serif; transition:border-color 0.2s, box-shadow 0.2s;
    height:30px;
  }
  #topbar input::placeholder { color:var(--muted); }
  #topbar input:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(121,192,255,0.1); }
  #topbar .match-count {
    position:absolute; top:50%; right:10px; transform:translateY(-50%);
    color:var(--muted); font-size:10px; font-weight:600; pointer-events:none;
  }
  #topbar .sep { width:1px; height:18px; background:var(--border); margin:0 2px; }
  #topbar .btn {
    padding:4px 10px; border:1px solid var(--border); border-radius:6px;
    background:transparent; color:var(--text-secondary); cursor:pointer; font-size:11px;
    font-family:'Inter',sans-serif; font-weight:500; transition:all 0.2s; white-space:nowrap; display:flex; align-items:center; gap:4px;
    height:28px; letter-spacing:0.01em;
  }
  #topbar .btn:hover { color:var(--text); border-color:var(--border-light); background:var(--surface-raised); }
  #topbar .btn.active { color:var(--blue); border-color:var(--blue); background:rgba(121,192,255,0.06); }
  #topbar .stats { color:var(--text-secondary); font-size:11px; font-weight:500; margin-left:auto; opacity:0.8; }

  /* Legend */
  #legend {
    position:absolute; bottom:38px; left:16px; z-index:10;
    background:rgba(18,21,27,0.92); border:1px solid var(--border); border-radius:10px;
    padding:12px 16px; max-height:50vh; overflow-y:auto;
    display:flex; flex-direction:column; gap:4px; min-width:170px;
    box-shadow:0 4px 24px rgba(0,0,0,0.5);
    backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
  }
  #legend .group-title { font-size:9px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:1.2px; margin-top:8px; font-family:'Inter',sans-serif; }
  #legend .group-title:first-child { margin-top:0; }
  .legend-row { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text-secondary); min-height:20px; }
  .legend-row .legend-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .legend-row .legend-count { color:var(--muted); font-size:10px; font-weight:600; }
  .legend-filter { border-radius:6px; padding:2px 4px; margin-left:-4px; margin-right:-4px; transition:background 0.15s, opacity 0.15s; }
  .legend-filter:hover { background:rgba(88,166,255,0.08); }
  .legend-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; box-shadow:0 0 6px currentColor; }
  .legend-line { width:20px; height:2px; flex-shrink:0; border-radius:2px; }

  /* Side Panel */
  #panel {
    position:absolute; top:48px; right:14px; z-index:15; width:400px; max-height:calc(100vh - 70px);
    background:rgba(26,30,38,0.95); border:1px solid var(--border); border-radius:12px;
    overflow-y:auto; display:none; box-shadow:0 16px 48px rgba(0,0,0,0.7);
    backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
  }
  #panel.active { display:block; }
  #panel-header {
    display:flex; align-items:flex-start; justify-content:space-between;
    padding:16px 18px 12px; border-bottom:1px solid var(--border);
    position:sticky; top:0; background:rgba(26,30,38,0.98); z-index:1;
    backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
  }
  #panel-header .type-badge {
    display:inline-block; padding:3px 10px; border-radius:12px; font-size:11px; font-weight:600; margin-bottom:6px;
    font-family:'Inter',sans-serif;
  }
  #panel-header h3 { font-size:16px; margin:0; word-break:break-all; font-weight:600; color:var(--text); }
  #panel-header .close-btn { background:none; border:none; color:var(--muted); cursor:pointer; font-size:20px; padding:0 0 0 8px; line-height:1; transition:color 0.15s; }
  #panel-header .close-btn:hover { color:var(--text); }
  #panel-body { padding:12px 18px 18px; }
  #panel-body .path { color:var(--muted); font-size:11px; word-break:break-all; margin-bottom:12px; font-family:'JetBrains Mono',monospace; }
  #panel-body .summary {
    display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:14px;
  }
  #panel-body .summary .metric {
    border:1px solid rgba(42,48,64,0.8); border-radius:8px; padding:7px 8px;
    background:rgba(10,12,16,0.32);
  }
  #panel-body .summary .num { display:block; color:var(--text); font-weight:700; font-size:14px; line-height:1.1; }
  #panel-body .summary .lbl { color:var(--muted); font-size:9px; text-transform:uppercase; letter-spacing:0.8px; }
  #panel-body .section { margin-top:16px; }
  #panel-body .section-title {
    font-size:10px; font-weight:600; color:var(--muted); text-transform:uppercase;
    letter-spacing:1.2px; margin-bottom:8px; display:flex; align-items:center; gap:6px;
    font-family:'Inter',sans-serif;
  }
  #panel-body .section-title .count { font-weight:400; color:var(--muted); }
  #panel-body .props { font-size:12px; }
  #panel-body .props .row { display:grid; grid-template-columns:110px 1fr; gap:12px; padding:6px 0; border-bottom:1px solid rgba(42,48,64,0.4); }
  #panel-body .props .row .k { color:var(--text-secondary); }
  #panel-body .props .row .v { color:var(--green); font-family:'JetBrains Mono',monospace; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:normal; word-break:break-word; text-align:right; }
  #panel-body .edge-item {
    display:flex; align-items:center; gap:6px; padding:5px 0; font-size:12px; border-bottom:1px solid rgba(42,48,64,0.2);
    cursor:pointer; transition:background 0.15s; border-radius:4px; padding-left:2px;
  }
  #panel-body .edge-item:hover { background:rgba(88,166,255,0.06); }
  #panel-body .edge-item .rel-badge { font-size:9px; padding:1px 6px; border-radius:8px; font-weight:600; flex-shrink:0; font-family:'Inter',sans-serif; }
  #panel-body .edge-item .edge-label {
    flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text);
    font-family:'JetBrains Mono',monospace; font-size:11px;
  }
  #panel-body .edge-item .edge-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
  #panel-body .edge-item .edge-meta {
    color:var(--muted); font-family:'JetBrains Mono',monospace; font-size:10px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }

  #status-bar {
    position:absolute; bottom:0; left:0; right:0; padding:6px 16px;
    background:rgba(18,21,27,0.88); border-top:1px solid var(--border);
    display:flex; align-items:center; gap:8px; font-size:11px; color:var(--text-secondary);
    z-index:5; font-family:'Inter',sans-serif;
    backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  }

  /* Tooltip */
  #tooltip {
    position:absolute; display:none; background:rgba(18,21,27,0.95); color:var(--text);
    border:1px solid var(--border-light); border-radius:8px; padding:10px 14px;
    font-size:12px; pointer-events:none; z-index:25; box-shadow:0 8px 28px rgba(0,0,0,0.6);
    white-space:nowrap; line-height:1.5;
    backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  }
  #tooltip .tt-name { font-weight:600; font-size:13px; font-family:'Inter',sans-serif; }
  #tooltip .tt-detail { color:var(--text-secondary); font-size:11px; font-family:'JetBrains Mono',monospace; }
  #tooltip .tt-rel { color:var(--yellow); font-size:10px; font-weight:600; }

  /* Edge toggle dropdown */
  #edge-dropdown {
    position:absolute; top:36px; display:none; flex-direction:column;
    background:rgba(26,30,38,0.96); border:1px solid var(--border-light); border-radius:10px;
    padding:6px 0; box-shadow:0 12px 36px rgba(0,0,0,0.6); z-index:50; min-width:190px;
    backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
  }
  #edge-dropdown.show { display:flex; }
  #edge-dropdown .dd-item {
    display:flex; align-items:center; gap:8px; padding:7px 16px; cursor:pointer;
    font-size:12px; color:var(--text-secondary); transition:all 0.15s; font-family:'Inter',sans-serif;
  }
  #edge-dropdown .dd-item:hover { background:rgba(88,166,255,0.06); color:var(--text); }
  #edge-dropdown .dd-item .check { width:14px; height:14px; border:1px solid var(--border-light); border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:10px; }
  #edge-dropdown .dd-item.on .check { background:var(--blue); border-color:var(--blue); color:#fff; }
  #edge-dropdown .dd-item.on { color:var(--text); }

  /* Loading overlay */
  #loading {
    position:absolute; inset:0; z-index:100; display:flex; flex-direction:column;
    align-items:center; justify-content:center; background:var(--bg);
    color:var(--text-secondary); font-size:14px; gap:14px; font-family:'Inter',sans-serif;
  }
  #loading .spinner {
    width:40px; height:40px; border:3px solid var(--border);
    border-top-color:var(--blue); border-radius:50%;
    animation:spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform:rotate(360deg); } }

  /* Mobile notice */
  @media (max-width:600px) {
    #panel { width:calc(100vw - 28px); }
    #topbar .btn span.lbl { display:none; }
  }
</style>
</head>
<body>
<div id="canvas"></div>
<div id="topbar">
  <div class="search-wrap">
    <input id="search" placeholder="Search entities by name, path, or type..." autofocus>
    <span class="match-count" id="match-count"></span>
  </div>
  <span class="sep"></span>
  <button class="btn" id="btn-reset" title="Reset view">&#x1F504; <span class="lbl">Reset</span></button>
  <button class="btn active" id="btn-edges" title="Toggle edge types">&#x1F517; <span class="lbl">Edges</span></button>
  <button class="btn" id="btn-layout" title="Re-run layout">&#x25F3; <span class="lbl">Layout</span></button>
  <span class="stats" id="stats"></span>
</div>
<div id="edge-dropdown"></div>
<div id="panel">
  <div id="panel-header">
    <div><span class="type-badge" id="panel-badge"></span><h3 id="panel-name"></h3></div>
    <button class="close-btn" id="panel-close">&times;</button>
  </div>
  <div id="panel-body"></div>
</div>
<div id="tooltip"></div>
<div id="legend"></div>
<div id="loading"><div class="spinner"></div><div>Loading knowledge graph...</div></div>
<div id="status-bar">
  <span id="status-hint">Click node to inspect &middot; Scroll to zoom &middot; Drag to pan</span>
</div>

<script src="/sigma.min.js"></script>
<script src="/graphology.min.js"></script>

<script>
(function() {
'use strict';

// ===== CONSTANTS =====
var TYPE_COLORS = {
  component: '#79c0ff',
  store: '#56d364',
  route: '#e3b341',
  composable: '#bc8cff',
  legacy_module: '#ff7b72',
  'electron-main': '#f0883e',
  preload: '#39d2c0',
  chart_component: '#e3b341',
  server_api_composable: '#56d4dd',
  mixin: '#f778ba',
  page: '#79c0ff',
  layout: '#79c0ff',
  plugin: '#e3b341',
  package: '#6e7681',
};

var EDGE_COLORS = {
  imports: '#8b949e',
  USES_API: '#79c0ff',
  uses_store: '#56d364',
  uses_store_item: '#7ee787',
  uses_component: '#79c0ff',
  uses_composable: '#bc8cff',
  matches_route: '#e3b341',
  route_to_component: '#f2cc60',
  uses_mixin: '#f778ba',
  ipc_channel: '#39d2c0',
  exposes_ipc: '#4db6ac',
  calls_ipc: '#f0883e',
  has_state: '#e3b341',
  has_getter: '#56d4dd',
  has_action: '#f778ba',
  has_mutation: '#ff7b72',
  belongs_to: '#8b949e',
};

var EDGE_WIDTH = {
  imports: 0.25,
  USES_API: 0.35,
  uses_store: 0.5,
  uses_store_item: 0.55,
  uses_component: 0.45,
  uses_composable: 0.4,
  matches_route: 0.5,
  route_to_component: 0.55,
  ipc_channel: 0.5,
  exposes_ipc: 0.5,
  calls_ipc: 0.55,
  has_state: 0.3,
  has_getter: 0.3,
  has_action: 0.3,
  has_mutation: 0.3,
  belongs_to: 0.2,
};

var NODE_SIZES = {
  component: 5,
  store: 4.5,
  route: 4,
  composable: 3.5,
  legacy_module: 5,
  'electron-main': 4.8,
  preload: 4.4,
  chart_component: 5,
};

var INCOMING_COLOR = '#f0883e';  // warm orange for incoming
var OUTGOING_COLOR = '#58a6ff';  // bright blue for outgoing

// ===== GLOBAL STATE =====
var allData = null;
var graph = null;
var sigmaInst = null;
var selectedNode = null;
var highlightedNodes = new Set();
var edgeVisibility = {};
var layoutRunning = false;

// Helpers
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function(ch) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch];
  });
}

function typeColor(t) { return TYPE_COLORS[t] || '#6e7681'; }
function edgeColor(t) { return EDGE_COLORS[t] || '#8b949e'; }
function edgeWidth(t) { return EDGE_WIDTH[t] || 0.5; }
function nodeSize(t) { return NODE_SIZES[t] || 4; }
function shortPath(p) {
  var pathValue = String(p || '');
  var parts = pathValue.split(/[\\\\/]+/);
  return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : pathValue;
}

function rgba(hex, alpha) {
  var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return 'rgba('+r+','+g+','+b+','+alpha+')';
}

// ===== EDGE CURVE RENDERING =====
// Custom bezier edge rendering: draw quadratic bezier curves between nodes
function drawCurvedEdges() {
  if (!sigmaInst || !graph) return;
  var ctx = sigmaInst.getContext();
  if (!ctx) return;

  // Sigma v3 internal access — get the camera and canvas context
  // We override edge rendering by using a custom reducer approach
}

// ===== FORCEATLAS2 LAYOUT =====
function runForceAtlas2(g, opts) {
  opts = opts || {};
  var iters = opts.iterations || 200;
  var settings = {
    gravity: opts.gravity || 1,
    scalingRatio: opts.scalingRatio || 2,
    slowDown: opts.slowDown || 1,
    barnesHutOptimize: opts.barnesHutOptimize !== false,
    edgeWeightInfluence: opts.edgeWeightInfluence || 1,
    outboundAttractionDistribution: opts.outboundAttractionDistribution !== false,
    linLogMode: opts.linLogMode || false,
    strongGravityMode: opts.strongGravityMode || false,
  };

  var nodes = g.nodes();
  var N = nodes.length;
  if (N < 2) return;

  // Current positions
  var pos = {};
  for (var i = 0; i < N; i++) {
    var n = nodes[i];
    pos[n] = { x: g.getNodeAttribute(n, 'x') || (Math.random()-0.5)*10, y: g.getNodeAttribute(n, 'y') || (Math.random()-0.5)*10 };
  }

  // Build adjacency for speed
  var adj = {};
  var deg = {};
  for (var i2 = 0; i2 < N; i2++) { adj[nodes[i2]] = {}; deg[nodes[i2]] = 0; }
  g.forEachEdge(function(edge, attrs, src, tgt) {
    var w = edgeWidth(attrs.label || '') || 1;
    var eW = settings.edgeWeightInfluence === 0 ? 1 : Math.pow(w, settings.edgeWeightInfluence);
    adj[src][tgt] = (adj[src][tgt] || 0) + eW;
    adj[tgt][src] = (adj[tgt][src] || 0) + eW;
    deg[src]++; deg[tgt]++;
  });

  for (var iter = 0; iter < iters; iter++) {
    var disp = {};
    for (var i3 = 0; i3 < N; i3++) { disp[nodes[i3]] = { x:0, y:0 }; }

    // Repulsion (Barnes-Hut style simplification)
    if (settings.barnesHutOptimize && N > 200) {
      // Simple grid-based repulsion for performance
      var cellSize = 100;
      var grid = {};
      for (var i4 = 0; i4 < N; i4++) {
        var n4 = nodes[i4];
        var cx = Math.floor(pos[n4].x / cellSize), cy = Math.floor(pos[n4].y / cellSize);
        var key = cx+','+cy;
        (grid[key] = grid[key] || []).push(n4);
      }
      for (var i5 = 0; i5 < N; i5++) {
        var a = nodes[i5];
        var cx2 = Math.floor(pos[a].x / cellSize), cy2 = Math.floor(pos[a].y / cellSize);
        for (var dx = -1; dx <= 1; dx++) {
          for (var dy = -1; dy <= 1; dy++) {
            var cell = grid[(cx2+dx)+','+(cy2+dy)];
            if (!cell) continue;
            for (var c = 0; c < cell.length; c++) {
              var b2 = cell[c];
              if (b2 <= a) continue;
              var ddx = pos[a].x - pos[b2].x, ddy = pos[a].y - pos[b2].y;
              var d2 = ddx*ddx + ddy*ddy;
              if (d2 < 1) d2 = 1;
              var f = settings.scalingRatio / d2;
              var nd = Math.sqrt(d2);
              disp[a].x += f * ddx / nd; disp[a].y += f * ddy / nd;
              disp[b2].x -= f * ddx / nd; disp[b2].y -= f * ddy / nd;
            }
          }
        }
      }
    } else {
      for (var i6 = 0; i6 < N; i6++) {
        for (var j6 = i6+1; j6 < N; j6++) {
          var aa = nodes[i6], bb = nodes[j6];
          var dx = pos[aa].x - pos[bb].x, dy = pos[aa].y - pos[bb].y;
          var d2 = dx*dx + dy*dy;
          if (d2 < 1) d2 = 1;
          var f = settings.scalingRatio / d2;
          var nd = Math.sqrt(d2);
          disp[aa].x += f * dx / nd; disp[aa].y += f * dy / nd;
          disp[bb].x -= f * dx / nd; disp[bb].y -= f * dy / nd;
        }
      }
    }

    // Gravity
    for (var i7 = 0; i7 < N; i7++) {
      var n7 = nodes[i7];
      var d = Math.sqrt(pos[n7].x*pos[n7].x + pos[n7].y*pos[n7].y) || 1;
      var gf = settings.strongGravityMode ? settings.gravity * d : settings.gravity;
      disp[n7].x -= gf * pos[n7].x / d;
      disp[n7].y -= gf * pos[n7].y / d;
    }

    // Attraction
    for (var i8 = 0; i8 < N; i8++) {
      var n8 = nodes[i8];
      var nbrs = adj[n8];
      var nKeys = Object.keys(nbrs);
      if (nKeys.length === 0) continue;

      for (var k8 = 0; k8 < nKeys.length; k8++) {
        var tgt8 = nKeys[k8];
        var w8 = nbrs[tgt8];
        var dx8 = pos[tgt8].x - pos[n8].x;
        var dy8 = pos[tgt8].y - pos[n8].y;
        var d8 = Math.sqrt(dx8*dx8 + dy8*dy8) || 1;
        var dist = settings.linLogMode ? Math.log(1 + d8) : d8;
        var factor = settings.outboundAttractionDistribution ?
          w8 / deg[n8] * dist : w8 * dist;
        disp[n8].x += factor * dx8 / d8;
        disp[n8].y += factor * dy8 / d8;
      }
    }

    // Apply displacements with slowdown
    var maxDisp = 0;
    for (var i9 = 0; i9 < N; i9++) {
      var n9 = nodes[i9];
      var dx9 = disp[n9].x, dy9 = disp[n9].y;
      var m = Math.sqrt(dx9*dx9 + dy9*dy9);
      maxDisp = Math.max(maxDisp, m);
      var s = m > 0 ? Math.min(m / settings.slowDown, 10) / m : 0;
      pos[n9].x += dx9 * s;
      pos[n9].y += dy9 * s;
    }

    if (maxDisp < 0.1) break;
  }

  // Apply
  for (var i10 = 0; i10 < N; i10++) {
    var n10 = nodes[i10];
    g.setNodeAttribute(n10, 'x', pos[n10].x);
    g.setNodeAttribute(n10, 'y', pos[n10].y);
  }
}

// ===== NOVERLAP =====
function runNoverlap(g) {
  var nodes = g.nodes();
  var N = nodes.length;
  if (N < 2) return;
  var margin = 3;
  var expansion = 1.05;
  var iters = 15;

  var rects = {};
  for (var i = 0; i < N; i++) {
    var n = nodes[i];
    var s = g.getNodeAttribute(n, 'size') || 6;
    var x = g.getNodeAttribute(n, 'x') || 0;
    var y = g.getNodeAttribute(n, 'y') || 0;
    var r = s * expansion + margin;
    rects[n] = { x: x, y: y, r: r };
  }

  for (var iter = 0; iter < iters; iter++) {
    var moved = false;
    for (var i2 = 0; i2 < N; i2++) {
      for (var j2 = i2+1; j2 < N; j2++) {
        var a = nodes[i2], b = nodes[j2];
        var ra = rects[a], rb = rects[b];
        var dx = ra.x - rb.x;
        var dy = ra.y - rb.y;
        var dist = Math.sqrt(dx*dx + dy*dy);
        var minDist = ra.r + rb.r;
        if (dist < minDist && dist > 0.01) {
          var overlap = (minDist - dist) / 2;
          var mx = dx / dist * overlap;
          var my = dy / dist * overlap;
          ra.x += mx; ra.y += my;
          rb.x -= mx; rb.y -= my;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  for (var i3 = 0; i3 < N; i3++) {
    var n3 = nodes[i3];
    g.setNodeAttribute(n3, 'x', rects[n3].x);
    g.setNodeAttribute(n3, 'y', rects[n3].y);
  }
}

// ===== BUILD GRAPH =====
function buildGraph(data) {
  var g = new graphology.MultiGraph();
  var nodeCount = data.nodes.length;
  var circleR = Math.max(300, Math.sqrt(nodeCount) * 45);

  // Initialize edge visibility
  var edgeTypes = {};
  for (var i = 0; i < data.edges.length; i++) {
    edgeTypes[data.edges[i].relType] = true;
  }
  edgeVisibility = edgeTypes;

  // Compute degree (connection count) for each node for size scaling
  var degree = {};
  for (var i = 0; i < nodeCount; i++) {
    degree[data.nodes[i].key] = 0;
  }
  for (var j = 0; j < data.edges.length; j++) {
    if (degree[data.edges[j].source] !== undefined) degree[data.edges[j].source]++;
    if (degree[data.edges[j].target] !== undefined) degree[data.edges[j].target]++;
  }

  // Compute degree range for normalization
  var maxDeg = 0, minDeg = 1e9;
  for (var k in degree) {
    maxDeg = Math.max(maxDeg, degree[k]);
    minDeg = Math.min(minDeg, degree[k]);
  }
  if (minDeg === maxDeg) maxDeg = minDeg + 1; // avoid div by zero

  for (var i = 0; i < nodeCount; i++) {
    var n = data.nodes[i];
    var angle = (2 * Math.PI * i) / nodeCount;
    var baseSize = nodeSize(n.entityType);
    // Scale size by degree: min connection = base, max connection = base * 2.5
    var deg = degree[n.key] || 0;
    var degScale = 1 + ((deg - minDeg) / (maxDeg - minDeg)) * 1.5;
    g.addNode(n.key, {
      label: n.label,
      entityType: n.entityType,
      filePath: n.filePath,
      // force label color via node attribute
      labelColor: '#e1e4e8',
      _properties: n.properties,
      _degree: deg,
      _baseSize: baseSize,
      size: Math.round(baseSize * degScale),
      color: typeColor(n.entityType),
      x: circleR * Math.cos(angle) + (Math.random()-0.5)*40,
      y: circleR * Math.sin(angle) + (Math.random()-0.5)*40,
      zIndex: 0,
    });
  }

  for (var j = 0; j < data.edges.length; j++) {
    var e = data.edges[j];
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      var eType = e.relType;
      g.addEdgeWithKey(e.source + '|' + eType + '|' + e.target + '|' + j,
        e.source, e.target, {
        label: eType,
        size: edgeWidth(eType),
        color: edgeColor(eType),
        type: 'arrow',
        zIndex: -1,
        hidden: false,
        _relType: eType,
        _properties: e.properties,
      });
    }
  }

  return g;
}

// ===== LEGEND =====
var entityVisibility = {}; // track which entity types are visible

function renderLegend(data, edgeTypes) {
  var html = '';
  // Node types — clickable for filtering
  html += '<div class="group-title">Entities (click to filter)</div>';
  var nodeTypes = {};
  for (var i = 0; i < data.nodes.length; i++) {
    var t = data.nodes[i].entityType;
    nodeTypes[t] = (nodeTypes[t] || 0) + 1;
    if (entityVisibility[t] === undefined) entityVisibility[t] = true;
  }
  var nodeKeys = Object.keys(nodeTypes).sort();
  for (var nk = 0; nk < nodeKeys.length; nk++) {
    var t = nodeKeys[nk];
    var vis = entityVisibility[t];
    html += '<div class="legend-row legend-filter" data-entity="'+escapeHtml(t)+'" aria-pressed="'+(vis ? 'true' : 'false')+'" title="Toggle '+escapeHtml(t)+'" style="cursor:pointer;' + (vis ? '' : 'opacity:0.35') + '">';
    html += '<span class="legend-dot" style="background:'+typeColor(t)+(vis ? '' : ';border:1px solid '+typeColor(t)+';background:transparent')+'"></span>';
    html += '<span class="legend-name">'+escapeHtml(t)+'</span><span class="legend-count">'+nodeTypes[t]+'</span>';
    html += '</div>';
  }

  // Edge types
  html += '<div class="group-title">Relations</div>';
  var edgeCounts = {};
  for (var ei = 0; ei < data.edges.length; ei++) {
    var relType = data.edges[ei].relType;
    edgeCounts[relType] = (edgeCounts[relType] || 0) + 1;
  }
  var edgeKeys = Object.keys(edgeTypes).sort();
  for (var ek = 0; ek < edgeKeys.length; ek++) {
    var et = edgeKeys[ek];
    var c = edgeColor(et);
    var edgeOn = edgeVisibility[et] !== false;
    html += '<div class="legend-row" style="'+(edgeOn ? '' : 'opacity:0.35')+'"><span class="legend-line" style="background:'+c+'"></span><span class="legend-name">'+escapeHtml(et)+'</span><span class="legend-count">'+(edgeCounts[et] || 0)+'</span></div>';
  }
  // Selection mode indicator
  html += '<div class="group-title">On Select</div>';
  html += '<div class="legend-row"><span class="legend-line" style="background:'+OUTGOING_COLOR+'"></span><span>outgoing</span></div>';
  html += '<div class="legend-row"><span class="legend-line" style="background:'+INCOMING_COLOR+'"></span><span>incoming</span></div>';
  document.getElementById('legend').innerHTML = html;

  // Attach click handlers for entity filtering
  document.querySelectorAll('.legend-filter').forEach(function(el) {
    el.addEventListener('click', function() {
      var entityType = el.getAttribute('data-entity');
      toggleEntityVisibility(entityType);
    });
  });
}

function toggleEntityVisibility(entityType) {
  entityVisibility[entityType] = !entityVisibility[entityType];
  applyVisibilityFilters();
  if (selectedNode && graph.getNodeAttribute(selectedNode, 'hidden')) hidePanel();
  var searchInput = document.getElementById('search');
  if (searchInput && searchInput.value) filterNodes(searchInput.value);
  else if (sigmaInst) sigmaInst.refresh();
  renderLegend(allData, getEdgeTypesFromGraph());
}

function getEdgeTypesFromGraph() {
  var edgeTypes = {};
  graph.forEachEdge(function(edge, attrs) { edgeTypes[attrs._relType] = true; });
  return edgeTypes;
}

function applyVisibilityFilters() {
  graph.forEachNode(function(node, attrs) {
    graph.setNodeAttribute(node, 'hidden', entityVisibility[attrs.entityType] === false);
  });
  graph.forEachEdge(function(edge, attrs, src, tgt, sAttrs, tAttrs) {
    var hiddenByType = edgeVisibility[attrs._relType] === false;
    var hiddenByNode = entityVisibility[sAttrs.entityType] === false || entityVisibility[tAttrs.entityType] === false;
    graph.setEdgeAttribute(edge, 'hidden', hiddenByType || hiddenByNode);
  });
}

// ===== BUILD EDGE TOGGLE DROPDOWN =====
function buildEdgeDropdown(edgeTypes) {
  var dd = document.getElementById('edge-dropdown');
  var html = '';
  var keys = Object.keys(edgeTypes).sort();
  for (var i = 0; i < keys.length; i++) {
    var et = keys[i];
    html += '<div class="dd-item '+(edgeVisibility[et] === false ? '' : 'on')+'" data-type="'+escapeHtml(et)+'">';
    html += '<span class="check">&#x2713;</span>';
    html += '<span class="legend-line" style="width:14px;height:2px;background:'+edgeColor(et)+';flex-shrink:0;"></span>';
    html += '<span>'+escapeHtml(et)+'</span>';
    html += '</div>';
  }
  dd.innerHTML = html;
  dd.querySelectorAll('.dd-item').forEach(function(el) {
    el.addEventListener('click', function() {
      toggleEdgeType(el.getAttribute('data-type'));
    });
  });
}

function toggleEdgeType(et) {
  edgeVisibility[et] = !edgeVisibility[et];
  applyVisibilityFilters();
  if (sigmaInst) sigmaInst.refresh();
  document.querySelectorAll('#edge-dropdown .dd-item').forEach(function(item) {
    if (item.getAttribute('data-type') === et) item.classList.toggle('on', edgeVisibility[et]);
  });
  renderLegend(allData, getEdgeTypesFromGraph());
}

// ===== PANEL =====
function formatValue(v, limit) {
  var max = limit || 120;
  if (v === null || v === undefined) return 'n/a';
  var text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (text.length > max) return text.substring(0, max - 1) + '...';
  return text;
}

function edgeMeta(edge) {
  var p = edge.props || {};
  var bits = [];
  if (p.itemName) bits.push(p.itemName);
  if (p.channel) bits.push('channel ' + p.channel);
  if (p.guard) bits.push('guard ' + p.guard);
  if (p.routePath) bits.push(p.routePath);
  if (p.source) bits.push(p.source);
  if (p.evidence) bits.push(p.evidence);
  if (p.line) bits.push('line ' + p.line);
  return bits.slice(0, 3).join(' · ');
}

function showPanel(nodeKey) {
  var attrs = graph.getNodeAttributes(nodeKey);
  var badge = document.getElementById('panel-badge');
  var nameEl = document.getElementById('panel-name');
  var body = document.getElementById('panel-body');

  badge.textContent = attrs.entityType;
  badge.style.background = typeColor(attrs.entityType) + '22';
  badge.style.color = typeColor(attrs.entityType);
  nameEl.textContent = attrs.label || attrs.filePath;

  // Gather edges
  var outEdges = [];
  var inEdges = [];
  graph.forEachEdge(nodeKey, function(edge, eAttrs, src, tgt, sAttrs, tAttrs) {
    var e = { label: eAttrs.label, source: src, target: tgt, srcLabel: sAttrs.label, tgtLabel: tAttrs.label, props: eAttrs._properties || {} };
    if (src === nodeKey) outEdges.push(e);
    else inEdges.push(e);
  });

  var props = attrs._properties || {};
  var html = '<div class="path" title="'+escapeHtml(attrs.filePath || '')+'">'+escapeHtml(shortPath(attrs.filePath || ''))+'</div>';
  html += '<div class="summary">';
  html += '<div class="metric"><span class="num">'+(attrs._degree || 0)+'</span><span class="lbl">Links</span></div>';
  html += '<div class="metric"><span class="num">'+outEdges.length+'</span><span class="lbl">Outgoing</span></div>';
  html += '<div class="metric"><span class="num">'+inEdges.length+'</span><span class="lbl">Incoming</span></div>';
  html += '</div>';

  // Properties
  var propKeys = Object.keys(props).filter(function(k) { return !k.startsWith('_'); });
  if (propKeys.length > 0) {
    html += '<div class="section"><div class="section-title">Properties</div><div class="props">';
    for (var pi = 0; pi < propKeys.length; pi++) {
      var pk = propKeys[pi];
      var pv = props[pk];
      var displayV = Array.isArray(pv) ? pv.map(function(item) { return formatValue(item, 60); }).join(', ') : formatValue(pv, 180);
      html += '<div class="row"><span class="k">'+escapeHtml(pk)+'</span><span class="v" title="'+escapeHtml(formatValue(pv, 800))+'">'+escapeHtml(displayV)+'</span></div>';
    }
    html += '</div></div>';
  }

  // Outgoing
  if (outEdges.length > 0) {
    html += '<div class="section"><div class="section-title">Outgoing <span class="count">('+outEdges.length+')</span></div>';
    for (var oi = 0; oi < outEdges.length; oi++) {
      var oe = outEdges[oi];
      var oeMeta = edgeMeta(oe);
      html += '<div class="edge-item" data-node="'+escapeHtml(oe.target)+'">';
      html += '<span class="rel-badge" style="background:'+edgeColor(oe.label)+'22;color:'+edgeColor(oe.label)+'">'+escapeHtml(oe.label)+'</span>';
      html += '<span class="edge-copy"><span class="edge-label">&rarr; '+escapeHtml(oe.tgtLabel || oe.target)+'</span>';
      if (oeMeta) html += '<span class="edge-meta">'+escapeHtml(oeMeta)+'</span>';
      html += '</span>';
      html += '</div>';
    }
    html += '</div>';
  }

  // Incoming
  if (inEdges.length > 0) {
    html += '<div class="section"><div class="section-title">Incoming <span class="count">('+inEdges.length+')</span></div>';
    for (var ii = 0; ii < inEdges.length; ii++) {
      var ie = inEdges[ii];
      var ieMeta = edgeMeta(ie);
      html += '<div class="edge-item" data-node="'+escapeHtml(ie.source)+'">';
      html += '<span class="rel-badge" style="background:'+edgeColor(ie.label)+'22;color:'+edgeColor(ie.label)+'">'+escapeHtml(ie.label)+'</span>';
      html += '<span class="edge-copy"><span class="edge-label">&larr; '+escapeHtml(ie.srcLabel || ie.source)+'</span>';
      if (ieMeta) html += '<span class="edge-meta">'+escapeHtml(ieMeta)+'</span>';
      html += '</span>';
      html += '</div>';
    }
    html += '</div>';
  }

  body.innerHTML = html;
  body.querySelectorAll('.edge-item[data-node]').forEach(function(el) {
    el.addEventListener('click', function() {
      navigateToNode(el.getAttribute('data-node'));
    });
  });
  document.getElementById('panel').classList.add('active');
  selectedNode = nodeKey;
  applyNodeHighlight();
}

function navigateToNode(nodeKey) {
  if (graph.hasNode(nodeKey)) {
    showPanel(nodeKey);
    if (sigmaInst) {
      sigmaInst.getCamera().animate(nodeKey, { duration: 400 });
    }
  }
}

function hidePanel() {
  document.getElementById('panel').classList.remove('active');
  selectedNode = null;
  applyNodeHighlight();
}

// ===== NODE HIGHLIGHTING (Reducer) =====
var animationFrame = null;
var pulseTime = 0;

function applyNodeHighlight() {
  if (sigmaInst) sigmaInst.refresh();
}

function startAnimationLoop() {
  if (animationFrame) return;
  var animate = function(ts) {
    pulseTime = ts;
    animationFrame = requestAnimationFrame(animate);
    // Subtle pulse for highlighted nodes via canvas refresh
  };
  animationFrame = requestAnimationFrame(animate);
}

// ===== SEARCH =====
function filterNodes(query) {
  if (!graph) return;
  highlightedNodes = new Set();
  var q = query.toLowerCase().trim();

  if (q) {
    graph.forEachNode(function(node, attrs) {
      if (attrs.hidden) return;
      var match = String(attrs.label || '').toLowerCase().indexOf(q) >= 0 ||
        String(attrs.filePath || '').toLowerCase().indexOf(q) >= 0 ||
        String(attrs.entityType || '').toLowerCase().indexOf(q) >= 0;
      if (match) highlightedNodes.add(node);
    });
  }

  document.getElementById('match-count').textContent = q ? highlightedNodes.size + ' match' + (highlightedNodes.size === 1 ? '' : 'es') : '';
  applyNodeHighlight();
  if (sigmaInst) sigmaInst.refresh();
}

// ===== ANIMATION LOOP =====
function startPulseAnimation() {
  var lastTime = 0;
  var animate = function(ts) {
    if (lastTime === 0) lastTime = ts;
    var dt = (ts - lastTime) / 1000;
    lastTime = ts;

    if (highlightedNodes.size > 0 && sigmaInst) {
      // Pulse effect is achieved through node size oscillation
      var phase = ts * 0.003;
      var scale = 1 + 0.15 * Math.sin(phase);
      highlightedNodes.forEach(function(nodeId) {
        if (graph.hasNode(nodeId)) {
          var attrs = graph.getNodeAttributes(nodeId);
          var base = nodeSize(attrs.entityType);
          if (selectedNode === nodeId) {
            graph.setNodeAttribute(nodeId, 'size', base * 3.5);
          } else if (!selectedNode || graph.neighbors(selectedNode).indexOf(nodeId) < 0) {
            graph.setNodeAttribute(nodeId, 'size', base * (2.5 * (0.85 + 0.15 * Math.sin(phase))));
          }
        }
      });
      sigmaInst.refresh();
    }
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

// ===== LAYOUT RUNNER =====
function runLayout() {
  if (!graph || layoutRunning) return;
  layoutRunning = true;
  document.getElementById('status-hint').textContent = 'Running ForceAtlas2 layout...';

  setTimeout(function() {
    // Adaptive settings based on node count
    var N = graph.nodes().length;
    var iters, gravity, scalingRatio, slowDown;

    if (N < 50)        { iters=300; gravity=0.5; scalingRatio=3; slowDown=1; }
    else if (N < 200)  { iters=250; gravity=0.8; scalingRatio=5; slowDown=2; }
    else if (N < 1000) { iters=200; gravity=1; scalingRatio=10; slowDown=3; }
    else               { iters=150; gravity=0.3; scalingRatio=30; slowDown=5; }

    runForceAtlas2(graph, {
      iterations: iters,
      gravity: gravity,
      scalingRatio: scalingRatio,
      slowDown: slowDown,
      barnesHutOptimize: N > 200,
    });

    document.getElementById('status-hint').textContent = 'Removing overlaps...';
    setTimeout(function() {
      runNoverlap(graph);
      sigmaInst.refresh();
      document.getElementById('status-hint').innerHTML = 'Click node to inspect &middot; Scroll to zoom &middot; Drag to pan';
      layoutRunning = false;
    }, 50);
  }, 100);
}

// ===== TOOLTIP =====
function setupHoverTooltip() {
  var tooltip = document.getElementById('tooltip');
  sigmaInst.on('enterNode', function(evt) {
    var attrs = graph.getNodeAttributes(evt.node);
    var html = '<div class="tt-name">'+escapeHtml(attrs.label)+'</div>';
    html += '<div class="tt-detail">'+escapeHtml(attrs.entityType)+' · '+escapeHtml(shortPath(attrs.filePath))+'</div>';
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
  });
  sigmaInst.on('leaveNode', function() {
    tooltip.style.display = 'none';
  });

  sigmaInst.on('enterEdge', function(evt) {
    var attrs = graph.getEdgeAttributes(evt.edge);
    var src = graph.getNodeAttributes(evt.source);
    var tgt = graph.getNodeAttributes(evt.target);
    var html = '<div class="tt-rel">'+escapeHtml(attrs.label)+'</div>';
    html += '<div class="tt-detail">'+escapeHtml(src.label)+' → '+escapeHtml(tgt.label)+'</div>';
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
  });
  sigmaInst.on('leaveEdge', function() {
    tooltip.style.display = 'none';
  });

  // Move tooltip with mouse
  document.addEventListener('mousemove', function(e) {
    if (tooltip.style.display === 'block') {
      tooltip.style.left = (e.clientX + 18) + 'px';
      tooltip.style.top = (e.clientY - 30) + 'px';
    }
  });
}

// ===== MAIN =====
fetch('/api/graph').then(function(r) { return r.json(); }).then(function(data) {
  if (data.error) { document.getElementById('loading').innerHTML='<span style="color:#f85149">Error: '+escapeHtml(data.error)+'</span>'; return; }
  if (!data.nodes || data.nodes.length === 0) {
    document.getElementById('loading').innerHTML='<span style="color:var(--muted)">No entities indexed. Run <code>code-sense index</code> first.</span>';
    return;
  }

  allData = data;
  graph = buildGraph(data);

  // Count types for legend
  var edgeTypes = {};
  for (var i = 0; i < data.edges.length; i++) { edgeTypes[data.edges[i].relType] = true; }

  renderLegend(data, edgeTypes);
  buildEdgeDropdown(edgeTypes);
  document.getElementById('stats').textContent = data.nodes.length + ' nodes, ' + data.edges.length + ' edges';

  // Sigma instance
  sigmaInst = new Sigma(graph, document.getElementById('canvas'), {
    renderEdgeLabels: false,
    defaultEdgeType: 'arrow',
    labelDensity: 0.07,
    labelGridCellSize: 70,
    labelRenderedSizeThreshold: 4,
    labelFont: 'JetBrains Mono,monospace',
    labelColor: { attribute: 'labelColor' },
    labelSize: 12,
    defaultNodeColor: '#484f58',
    defaultEdgeColor: '#2a3040',
    stagePadding: 50,
    enableEdgeEvents: true,
    hideEdgesOnMove: true,
    minCameraRatio: 0.002,
    maxCameraRatio: 50,
    // Disable default white hover ring — we handle selection with size + zIndex
    nodeHoverProgramClasses: {},
    defaultDrawNodeHover: function() {},
    nodeReducer: function(node, data) {
      if (data.hidden) return data;
      var isSel = selectedNode === node;
      var isNeighbor = selectedNode && graph && graph.neighbors(selectedNode).indexOf(node) >= 0;
      var isHL = highlightedNodes.has(node);
      var hasSel = selectedNode || highlightedNodes.size > 0;
      if (!hasSel) return data;
      if (isSel) {
        return { ...data, size: (data._baseSize || 6) * 4.5, zIndex: 100 };
      }
      if (isNeighbor) {
        return { ...data, size: (data._baseSize || 6) * 2.0, zIndex: 50 };
      }
      if (isHL) {
        return { ...data, size: (data._baseSize || 6) * 2.5, zIndex: 75 };
      }
      return { ...data, hidden: true };
    },
    edgeReducer: function(edge, data) {
      if (data.hidden) return data;
      if (!selectedNode && highlightedNodes.size === 0) return data;
      var src = graph ? graph.source(edge) : null;
      var tgt = graph ? graph.target(edge) : null;
      var isOut = selectedNode && src === selectedNode;
      var isIn = selectedNode && tgt === selectedNode;
      var hlConn = !selectedNode && (highlightedNodes.has(src) || highlightedNodes.has(tgt));
      if (isOut) {
        return { ...data, hidden: false, size: (edgeWidth(data._relType) || 0.5) * 2.5, color: OUTGOING_COLOR, zIndex: 25 };
      }
      if (isIn) {
        return { ...data, hidden: false, size: (edgeWidth(data._relType) || 0.5) * 2.5, color: INCOMING_COLOR, zIndex: 25 };
      }
      if (hlConn) {
        return { ...data, hidden: false, size: (edgeWidth(data._relType) || 0.5) * 2, zIndex: 20 };
      }
      return { ...data, hidden: true };
    },
  });

  // Hide loading overlay
  document.getElementById('loading').style.display = 'none';

  // Run layout
  setTimeout(runLayout, 200);

  // Setup interactions
  setupHoverTooltip();
  startPulseAnimation();

  // Click node → side panel
  sigmaInst.on('clickNode', function(evt) { showPanel(evt.node); });
  sigmaInst.on('clickStage', function() { hidePanel(); });

  // Double click → focus
  sigmaInst.on('doubleClickNode', function(evt) {
    sigmaInst.getCamera().animate(evt.node, { duration: 400, ratio: 0.15 });
  });

  // Search input
  var searchInput = document.getElementById('search');
  var searchTimer;
  searchInput.addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() { filterNodes(searchInput.value); }, 150);
  });

  // Button: Close panel
  document.getElementById('panel-close').addEventListener('click', hidePanel);

  // Button: Reset view
  document.getElementById('btn-reset').addEventListener('click', function() {
    searchInput.value = '';
    document.getElementById('match-count').textContent = '';
    highlightedNodes = new Set();
    hidePanel();
    applyNodeHighlight();
    sigmaInst.getCamera().animatedReset({ duration: 500 });
    sigmaInst.refresh();
  });

  // Button: Edge toggle dropdown
  var btnEdges = document.getElementById('btn-edges');
  var edgeDD = document.getElementById('edge-dropdown');
  btnEdges.addEventListener('click', function(e) {
    e.stopPropagation();
    edgeDD.classList.toggle('show');
    var rect = btnEdges.getBoundingClientRect();
    edgeDD.style.left = rect.left + 'px';
    edgeDD.style.top = (rect.bottom + 4) + 'px';
  });

  // Button: Re-run layout
  document.getElementById('btn-layout').addEventListener('click', runLayout);

  // Close dropdown on outside click
  document.addEventListener('click', function(e) {
    if (!edgeDD.contains(e.target) && e.target !== btnEdges) {
      edgeDD.classList.remove('show');
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      hidePanel();
      edgeDD.classList.remove('show');
      document.getElementById('search').value = '';
      document.getElementById('match-count').textContent = '';
      highlightedNodes = new Set();
      applyNodeHighlight();
      sigmaInst.refresh();
    }
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      document.getElementById('search').focus();
    }
  });

  // Expose globals for onclick handlers in panel
  window.toggleEdgeType = toggleEdgeType;
  window.navigateToNode = navigateToNode;

}).catch(function(err) {
  document.getElementById('loading').innerHTML = '<span style="color:#f85149">Failed to load: '+escapeHtml(err.message)+'</span>';
  console.error(err);
});

})();
</script>
</body>
</html>`;

export function startVisServer(dbPath: string, port: number = 3456): Promise<void> {
  return new Promise((resolve) => {
    const graph = new LbugGraph(dbPath);

    const sigmaPath = resolveModuleFile('sigma/dist/sigma.min.js');
    const graphologyPath = resolveModuleFile('graphology/dist/graphology.umd.min.js');

    const sigmaJS = readFileSync(sigmaPath, 'utf-8');
    const graphologyJS = readFileSync(graphologyPath, 'utf-8');

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      if (url === '/api/graph') {
        graphToVis(graph)
          .then((data) => {
            res.writeHead(200, { 'Content-Type': MIME['.json'] });
            res.end(JSON.stringify(data));
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': MIME['.json'] });
            res.end(JSON.stringify({ error: String(err) }));
          });
        return;
      }

      if (url === '/sigma.min.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'] });
        res.end(sigmaJS);
        return;
      }

      if (url === '/graphology.min.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'] });
        res.end(graphologyJS);
        return;
      }

      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(HTML_PAGE);
    });

    server.listen(port, () => {
      console.error(`[CodeSense] Graph visualization at http://localhost:${port}`);
      resolve();
    });
  });
}
