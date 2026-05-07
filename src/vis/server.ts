import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LbugGraph } from '../graph/lbug.js';
import { graphToVis } from './adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
<title>CodeSense — Graph View</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --blue: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --purple: #bc8cff;
    --red: #f85149;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif; overflow:hidden; }
  #canvas { position:absolute; inset:0; }
  #topbar {
    position:absolute; top:0; left:0; right:0; z-index:10;
    display:flex; align-items:center; gap:8px; padding:8px 12px;
    background:var(--surface); border-bottom:1px solid var(--border);
  }
  #topbar input {
    flex:1; max-width:320px; padding:5px 10px; border:1px solid var(--border);
    border-radius:4px; background:var(--bg); color:var(--text); font-size:13px;
    outline:none;
  }
  #topbar input:focus { border-color:var(--blue); }
  #topbar .hint { color:var(--muted); font-size:11px; }
  #topbar .count { color:var(--muted); font-size:12px; margin-left:auto; }
  #legend {
    position:absolute; bottom:16px; left:16px; z-index:10;
    display:flex; gap:10px; flex-wrap:wrap;
  }
  .legend-item { display:flex; align-items:center; gap:5px; font-size:12px; }
  .legend-dot { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
  #panel {
    position:absolute; top:44px; right:12px; z-index:10; width:340px; max-height:calc(100vh - 60px);
    background:var(--surface); border:1px solid var(--border); border-radius:8px;
    padding:16px; overflow-y:auto; display:none; box-shadow:0 8px 24px rgba(0,0,0,0.5);
  }
  #panel.active { display:block; }
  #panel .close { position:absolute; top:8px; right:12px; background:none; border:none; color:var(--muted); cursor:pointer; font-size:18px; }
  #panel .close:hover { color:var(--text); }
  #panel .type-badge {
    display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px;
    font-weight:600; margin-bottom:8px;
  }
  #panel h3 { font-size:15px; margin:6px 0 2px; word-break:break-all; }
  #panel .path { color:var(--muted); font-size:11px; word-break:break-all; margin-bottom:10px; }
  #panel .section { margin-top:12px; }
  #panel .section-title { font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
  #panel .props { font-size:12px; }
  #panel .props .row { display:flex; justify-content:space-between; padding:2px 0; border-bottom:1px solid var(--border); }
  #panel .props .row .k { color:var(--muted); }
  #panel .props .row .v { color:var(--green); font-family:monospace; font-size:11px; }
  #panel .edge { display:flex; align-items:center; gap:6px; padding:3px 0; font-size:12px; }
  #panel .edge .rel { color:var(--yellow); font-size:10px; }
  #panel .edge .target { color:var(--blue); cursor:pointer; }
  #panel .edge .target:hover { text-decoration:underline; }
  #tooltip {
    position:absolute; display:none; background:var(--surface); color:var(--text);
    border:1px solid var(--border); border-radius:6px; padding:8px 12px;
    font-size:12px; pointer-events:none; z-index:20; box-shadow:0 4px 12px rgba(0,0,0,0.4);
    white-space:nowrap;
  }
</style>
</head>
<body>
<div id="canvas"></div>
<div id="topbar">
  <input id="search" placeholder="Search entities..." autofocus>
  <span class="hint">Click node = inspect &nbsp;|&nbsp; Scroll = zoom &nbsp;|&nbsp; Drag = pan</span>
  <span class="count" id="nodecount"></span>
</div>
<div id="panel"><button class="close" id="panel-close">&times;</button><div id="panel-content"></div></div>
<div id="tooltip"></div>
<div id="legend"></div>

<script src="/sigma.min.js"></script>
<script src="/graphology.min.js"></script>

<script>
var TYPE_COLORS = {
  component: '#58a6ff',
  store: '#3fb950',
  route: '#d29922',
  composable: '#bc8cff',
  legacy_module: '#f85149',
};

// ---- force layout (Fruchterman-Reingold, runs in main thread) ----
function runForceLayout(graph, iters, opts) {
  opts = opts || {};
  var repulsion = opts.repulsion || 5000;
  var attraction = opts.attraction || 0.01;
  var maxDelta = opts.maxDelta || 10;
  var nodes = graph.nodes();
  var N = nodes.length;
  var pos = {};
  for (var i = 0; i < N; i++) {
    var n = nodes[i];
    pos[n] = { x: graph.getNodeAttribute(n, 'x') || 0, y: graph.getNodeAttribute(n, 'y') || 0 };
  }
  var edges = graph.edges().map(function(e) { return graph.extremities(e); });
  for (var iter = 0; iter < iters; iter++) {
    var disp = {};
    for (var i2 = 0; i2 < N; i2++) { disp[nodes[i2]] = { x:0, y:0 }; }
    // repulsion
    for (var i3 = 0; i3 < N; i3++) {
      for (var j = i3+1; j < N; j++) {
        var a = nodes[i3], b = nodes[j];
        var dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
        var d2 = Math.max(dx*dx+dy*dy, 1);
        var f = repulsion / d2;
        var fx = f * dx / Math.sqrt(d2), fy = f * dy / Math.sqrt(d2);
        disp[a].x += fx; disp[a].y += fy;
        disp[b].x -= fx; disp[b].y -= fy;
      }
    }
    // attraction
    for (var e = 0; e < edges.length; e++) {
      var src = edges[e][0], tgt = edges[e][1];
      var dx2 = pos[tgt].x - pos[src].x, dy2 = pos[tgt].y - pos[src].y;
      var d = Math.sqrt(dx2*dx2+dy2*dy2) || 1;
      var fa = attraction * d;
      disp[src].x += fa * dx2 / d; disp[src].y += fa * dy2 / d;
      disp[tgt].x -= fa * dx2 / d; disp[tgt].y -= fa * dy2 / d;
    }
    // apply
    for (var i4 = 0; i4 < N; i4++) {
      var n2 = nodes[i4];
      var dx3 = disp[n2].x, dy3 = disp[n2].y;
      var m = Math.sqrt(dx3*dx3+dy3*dy3);
      if (m > maxDelta) { dx3 = dx3/m*maxDelta; dy3 = dy3/m*maxDelta; }
      pos[n2].x += dx3; pos[n2].y += dy3;
    }
  }
  for (var i5 = 0; i5 < N; i5++) {
    var n3 = nodes[i5];
    graph.setNodeAttribute(n3, 'x', pos[n3].x);
    graph.setNodeAttribute(n3, 'y', pos[n3].y);
  }
}

// ---- main ----
(function() {
var allData = null, graph = null, sigmaInst = null;

function typeColor(t) { return TYPE_COLORS[t] || '#8b949e'; }

function shortPath(p) { return p.split('/').slice(-3).join('/'); }

function buildGraph(data) {
  var g = new graphology.Graph();
  var circleR = Math.max(200, data.nodes.length * 30);
  for (var i = 0; i < data.nodes.length; i++) {
    var n = data.nodes[i];
    var angle = (2 * Math.PI * i) / data.nodes.length;
    g.addNode(n.key, {
      label: n.label,
      entityType: n.entityType,
      filePath: n.filePath,
      size: 8,
      color: typeColor(n.entityType),
      x: circleR * Math.cos(angle),
      y: circleR * Math.sin(angle),
    });
  }
  for (var j = 0; j < data.edges.length; j++) {
    var e = data.edges[j];
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.addEdgeWithKey(e.source + '|' + e.relType + '|' + e.target + '|' + j,
        e.source, e.target, {
        label: e.relType,
        size: 1,
        color: '#484f58',
        type: 'arrow',
      });
    }
  }
  return g;
}

function renderLegend(types) {
  var html = '';
  for (var t in types) {
    html += '<div class="legend-item"><span class="legend-dot" style="background:' + typeColor(t) + '"></span>' + t + ' (' + types[t] + ')</div>';
  }
  document.getElementById('legend').innerHTML = html;
}

function showPanel(nodeKey) {
  var attrs = graph.getNodeAttributes(nodeKey);
  var panel = document.getElementById('panel');
  var content = document.getElementById('panel-content');

  // gather relations for this node
  var outEdges = [];
  var inEdges = [];
  graph.forEachEdge(nodeKey, function(edge, attrs2, src, tgt, srcAttrs, tgtAttrs) {
    var e = { label: attrs2.label, source: src, target: tgt, sourceLabel: srcAttrs.label, targetLabel: tgtAttrs.label };
    if (src === nodeKey) outEdges.push(e);
    else inEdges.push(e);
  });

  var html = '<span class="type-badge" style="background:' + typeColor(attrs.entityType) + '22;color:' + typeColor(attrs.entityType) + '">' + attrs.entityType + '</span>';
  html += '<h3>' + attrs.label + '</h3>';
  html += '<div class="path">' + attrs.filePath + '</div>';

  // properties from the graph JSON
  var nodeData = null;
  if (allData) {
    for (var i = 0; i < allData.nodes.length; i++) {
      if (allData.nodes[i].key === nodeKey) { nodeData = allData.nodes[i]; break; }
    }
  }
  if (nodeData && nodeData.properties && Object.keys(nodeData.properties).length > 0) {
    html += '<div class="section"><div class="section-title">Properties</div><div class="props">';
    for (var k in nodeData.properties) {
      var v = nodeData.properties[k];
      html += '<div class="row"><span class="k">' + k + '</span><span class="v">' + (typeof v === 'object' ? JSON.stringify(v) : String(v)) + '</span></div>';
    }
    html += '</div></div>';
  }

  if (outEdges.length > 0) {
    html += '<div class="section"><div class="section-title">Outgoing (' + outEdges.length + ')</div>';
    for (var o = 0; o < outEdges.length; o++) {
      var oe = outEdges[o];
      html += '<div class="edge"><span class="rel">' + oe.label + '</span> &rarr; <span class="target" data-node="' + oe.target + '">' + oe.targetLabel + '</span></div>';
    }
    html += '</div>';
  }
  if (inEdges.length > 0) {
    html += '<div class="section"><div class="section-title">Incoming (' + inEdges.length + ')</div>';
    for (var p = 0; p < inEdges.length; p++) {
      var ie = inEdges[p];
      html += '<div class="edge"><span class="target" data-node="' + ie.source + '">' + ie.sourceLabel + '</span> &rarr; <span class="rel">' + ie.label + '</span></div>';
    }
    html += '</div>';
  }

  content.innerHTML = html;
  panel.classList.add('active');

  // click on relation target → navigate
  content.querySelectorAll('.target').forEach(function(el) {
    el.addEventListener('click', function() {
      var nk = el.getAttribute('data-node');
      if (nk && graph.hasNode(nk)) showPanel(nk);
    });
  });
}

function hidePanel() {
  document.getElementById('panel').classList.remove('active');
}

function filterNodes(query) {
  if (!graph) return;
  var q = query.toLowerCase().trim();
  graph.forEachNode(function(node, attrs) {
    var match = !q || attrs.label.toLowerCase().indexOf(q) >= 0 || attrs.filePath.toLowerCase().indexOf(q) >= 0 || attrs.entityType.toLowerCase().indexOf(q) >= 0;
    graph.setNodeAttribute(node, 'hidden', !match);
  });
  if (sigmaInst) sigmaInst.refresh();
}

// load & render
fetch('/api/graph').then(function(r) { return r.json(); }).then(function(data) {
  if (data.error) { document.body.innerHTML = '<div style="color:#f85149;padding:40px;">Error: ' + data.error + '</div>'; return; }
  allData = data;

  graph = buildGraph(data);

  // count entity types
  var types = {};
  for (var i = 0; i < data.nodes.length; i++) { var t = data.nodes[i].entityType; types[t] = (types[t] || 0) + 1; }
  renderLegend(types);
  document.getElementById('nodecount').textContent = data.nodes.length + ' nodes, ' + data.edges.length + ' edges';

  sigmaInst = new Sigma(graph, document.getElementById('canvas'), {
    renderEdgeLabels: true,
    defaultEdgeType: 'arrow',
    labelDensity: 0.05,
    labelGridCellSize: 60,
    labelRenderedSizeThreshold: 8,
    defaultNodeColor: '#8b949e',
    defaultEdgeColor: '#30363d',
    stagePadding: 40,
  });

  // force layout
  setTimeout(function() {
    runForceLayout(graph, 100, { repulsion: 8000, attraction: 0.005, maxDelta: 8 });
    sigmaInst.refresh();
  }, 100);

  // Tooltip hover
  var tooltip = document.getElementById('tooltip');
  sigmaInst.on('enterNode', function(evt) {
    var attrs = graph.getNodeAttributes(evt.node);
    tooltip.innerHTML = '<strong>' + attrs.label + '</strong> &middot; ' + attrs.entityType + '<br><span style="color:#8b949e;font-size:11px">' + shortPath(attrs.filePath) + '</span>';
    tooltip.style.display = 'block';
    var rect = document.getElementById('canvas').getBoundingClientRect();
    tooltip.style.left = (evt.event.offsetX + 16) + 'px';
    tooltip.style.top = (evt.event.offsetY - 10) + 'px';
  });
  sigmaInst.on('leaveNode', function() { tooltip.style.display = 'none'; });

  // Click node → side panel
  sigmaInst.on('clickNode', function(evt) { showPanel(evt.node); });
  sigmaInst.on('clickStage', function() { hidePanel(); });

  // Search
  document.getElementById('search').addEventListener('input', function() {
    filterNodes(this.value);
  });

  // Close panel
  document.getElementById('panel-close').addEventListener('click', hidePanel);

  // Keyboard shortcut: Escape = close panel
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hidePanel();
  });
}).catch(function(err) {
  document.body.innerHTML = '<div style="color:#f85149;padding:40px;">Failed to load: ' + err.message + '</div>';
});
})();
</script>
</body>
</html>`;

export function startVisServer(dbPath: string, port: number = 3456): Promise<void> {
  return new Promise((resolve) => {
    const graph = new LbugGraph(dbPath);

    // Resolve paths to node_modules JS files
    const sigmaPath = path.resolve(__dirname, '../../node_modules/sigma/dist/sigma.min.js');
    const graphologyPath = path.resolve(__dirname, '../../node_modules/graphology/dist/graphology.umd.min.js');

    const sigmaJS = readFileSync(sigmaPath, 'utf-8');
    const graphologyJS = readFileSync(graphologyPath, 'utf-8');

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      if (url === '/api/graph') {
        graphToVis(graph).then((data) => {
          res.writeHead(200, { 'Content-Type': MIME['.json'] });
          res.end(JSON.stringify(data));
        }).catch((err) => {
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
