/**
 * Builds the standalone HTML page for `openMemoryGraph`.
 *
 * Self-contained on purpose: this file is written to disk and opened directly
 * with `file://`, so it cannot depend on a CDN (no network, no CSP host) or on
 * anything else in this repo. Everything — layout physics, rendering, styling —
 * is inlined into one string.
 */

export interface GraphNode {
  id: string;
  label: string;
  content: string;
  strength: number | undefined;
  retrievalCount: number;
  degree: number;
  isOrphan: boolean;
  createdAgo: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  mutual: boolean;
  type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  entityId: string;
  generatedAt: string;
}

/**
 * `</script>` inside a memory's own content would otherwise close the embedding
 * script tag early and truncate the page mid-JSON. `JSON.stringify` has no option
 * for this, so the closing angle bracket is escaped by hand after the fact.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function buildGraphHtml(data: GraphData): string {
  const nodeCount = data.nodes.length;
  const edgeCount = data.edges.length;
  const title = `Memory Graph — ${data.entityId}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root {
    color-scheme: light;
    --page:        #f9f9f7;
    --surface:     #fcfcfb;
    --text-1:      #0b0b0b;
    --text-2:      #52514e;
    --text-muted:  #898781;
    --border:      rgba(11,11,11,0.10);
    --grid:        #e1e0d9;
    --node-lo:     #cde2fb;
    --node-hi:     #0d366b;
    --node-orphan: #898781;
    --edge:        #c3c2b7;
    --edge-mutual: #52514e;
    --accent:      #2a78d6;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --page:        #0d0d0d;
      --surface:     #1a1a19;
      --text-1:      #ffffff;
      --text-2:      #c3c2b7;
      --text-muted:  #898781;
      --border:      rgba(255,255,255,0.10);
      --grid:        #2c2c2a;
      --node-lo:     #1c5cab;
      --node-hi:     #9ec5f4;
      --node-orphan: #52514e;
      --edge:        #383835;
      --edge-mutual: #c3c2b7;
      --accent:      #3987e5;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page:        #0d0d0d;
    --surface:     #1a1a19;
    --text-1:      #ffffff;
    --text-2:      #c3c2b7;
    --text-muted:  #898781;
    --border:      rgba(255,255,255,0.10);
    --grid:        #2c2c2a;
    --node-lo:     #1c5cab;
    --node-hi:     #9ec5f4;
    --node-orphan: #52514e;
    --edge:        #383835;
    --edge-mutual: #c3c2b7;
    --accent:      #3987e5;
  }

  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; overflow: hidden;
    background: var(--page); color: var(--text-1);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }

  #canvas { position: fixed; inset: 0; display: block; cursor: grab; }
  #canvas.dragging { cursor: grabbing; }

  header {
    position: fixed; top: 0; left: 0; right: 0; z-index: 10;
    display: flex; align-items: center; gap: 16px;
    padding: 14px 20px;
    background: linear-gradient(to bottom, var(--page) 60%, transparent);
    pointer-events: none;
  }
  header * { pointer-events: auto; }
  h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  .meta { font-size: 12px; color: var(--text-muted); }

  #search {
    margin-left: auto;
    width: 220px;
    padding: 7px 11px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-1);
    font-size: 13px;
    outline: none;
  }
  #search::placeholder { color: var(--text-muted); }
  #search:focus { border-color: var(--accent); }

  #legend {
    position: fixed; right: 20px; bottom: 20px; z-index: 10;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 11.5px;
    color: var(--text-2);
    min-width: 168px;
  }
  #legend .row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  #legend .row:first-of-type { margin-top: 8px; }
  #legend .title { font-weight: 600; color: var(--text-1); font-size: 12px; }
  #legend .ramp { width: 64px; height: 8px; border-radius: 4px; background: linear-gradient(to right, var(--node-lo), var(--node-hi)); }
  #legend .swatch { width: 14px; height: 14px; border-radius: 50%; flex: none; }
  #legend .line { width: 20px; height: 0; border-top: 2px solid var(--edge-mutual); flex: none; }
  #legend .line.dir { border-top-style: solid; border-top-color: var(--edge); }
  #legend .line.orphan { border: 1.5px dashed var(--node-orphan); border-radius: 50%; width: 12px; height: 12px; }

  #tooltip {
    position: fixed; z-index: 20; pointer-events: none;
    max-width: 320px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--text-1);
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    opacity: 0; transform: translateY(4px);
    transition: opacity 0.1s ease, transform 0.1s ease;
  }
  #tooltip.visible { opacity: 1; transform: translateY(0); }
  #tooltip .stats { margin-top: 6px; color: var(--text-muted); font-size: 11px; }

  #empty {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--text-muted); font-size: 14px; text-align: center; padding: 20px;
  }

  #zoom-hint {
    position: fixed; left: 20px; bottom: 20px; z-index: 10;
    font-size: 11px; color: var(--text-muted);
  }
</style>
</head>
<body>

<header>
  <div>
    <h1>${title}</h1>
    <div class="meta">${nodeCount} memor${nodeCount === 1 ? 'y' : 'ies'} · ${edgeCount} link${edgeCount === 1 ? '' : 's'} · generated ${data.generatedAt}</div>
  </div>
  <input id="search" type="text" placeholder="Filter memories…" autocomplete="off" />
</header>

<canvas id="canvas"></canvas>
<div id="tooltip"></div>
<div id="zoom-hint">scroll to zoom · drag to pan · drag a node to pin it</div>

<div id="legend">
  <div class="title">Legend</div>
  <div class="row"><div class="ramp"></div><span>strength (low → high)</span></div>
  <div class="row"><div class="line"></div><span>mutual link</span></div>
  <div class="row"><div class="line dir"></div><span>one-directional link</span></div>
  <div class="row"><div class="line orphan"></div><span>unlinked memory</span></div>
</div>

<script>
const DATA = ${embedJson({ nodes: data.nodes, edges: data.edges })};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const searchInput = document.getElementById('search');

if (DATA.nodes.length === 0) {
  const empty = document.createElement('div');
  empty.id = 'empty';
  empty.textContent = 'No memories stored yet.';
  document.body.appendChild(empty);
} else {
  runGraph();
}

function runGraph() {
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let width = window.innerWidth;
  let height = window.innerHeight;

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
  }
  resize();
  window.addEventListener('resize', resize);

  const nodeById = new Map();
  const degrees = DATA.nodes.map(n => n.degree);
  const maxDegree = Math.max(1, ...degrees);
  const strengths = DATA.nodes.map(n => n.strength ?? 0.5);
  const minStrength = Math.min(...strengths);
  const maxStrength = Math.max(...strengths);

  const nodes = DATA.nodes.map((n, i) => {
    const angle = (i / DATA.nodes.length) * Math.PI * 2;
    const radius = 120 + Math.random() * 60;
    const node = {
      ...n,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
      r: 6 + (n.degree / maxDegree) * 16,
    };
    nodeById.set(n.id, node);
    return node;
  });

  const links = DATA.edges
    .map(e => ({ ...e, a: nodeById.get(e.source), b: nodeById.get(e.target) }))
    .filter(l => l.a && l.b);

  // --- force simulation: simple spring/repulsion model, alpha-cooled like d3-force ---
  let alpha = 1;
  const ALPHA_DECAY = 0.985;
  const ALPHA_MIN = 0.001;
  const REPULSE_K = 2600;
  const SPRING_K = 0.02;
  const SPRING_LEN = 90;
  const CENTER_K = 0.0015;
  const DAMPING = 0.82;

  function tick() {
    if (alpha < ALPHA_MIN) return;
    for (let i = 0; i < nodes.length; i++) {
      const n1 = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const n2 = nodes[j];
        let dx = n1.x - n2.x;
        let dy = n1.y - n2.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) distSq = 1;
        const dist = Math.sqrt(distSq);
        const force = (REPULSE_K * alpha) / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        n1.vx += fx; n1.vy += fy;
        n2.vx -= fx; n2.vy -= fy;
      }
    }
    for (const l of links) {
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = (dist - SPRING_LEN) * SPRING_K * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      l.a.vx += fx; l.a.vy += fy;
      l.b.vx -= fx; l.b.vy -= fy;
    }
    for (const n of nodes) {
      n.vx += -n.x * CENTER_K * alpha;
      n.vy += -n.y * CENTER_K * alpha;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; }
      else { n.x += n.vx; n.y += n.vy; }
    }
    alpha *= ALPHA_DECAY;
  }

  // --- camera: pan/zoom ---
  let camX = 0, camY = 0, camK = 1;
  let dragging = null; // 'pan' | node
  let dragStart = null;
  let panStart = null;

  function worldToScreen(x, y) {
    return { x: width / 2 + (x - camX) * camK, y: height / 2 + (y - camY) * camK };
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - width / 2) / camK + camX, y: (sy - height / 2) / camK + camY };
  }

  function reheat() { alpha = Math.max(alpha, 0.3); }

  function colorForStrength(s) {
    const t = maxStrength > minStrength ? (s - minStrength) / (maxStrength - minStrength) : 0.5;
    return t;
  }

  function lerpColor(hexA, hexB, t) {
    const a = [1, 3, 5].map(i => parseInt(hexA.slice(i, i + 2), 16));
    const b = [1, 3, 5].map(i => parseInt(hexB.slice(i, i + 2), 16));
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return 'rgb(' + c.join(',') + ')';
  }

  const style = getComputedStyle(document.documentElement);
  const nodeLo = style.getPropertyValue('--node-lo').trim() || '#cde2fb';
  const nodeHi = style.getPropertyValue('--node-hi').trim() || '#0d366b';
  const nodeOrphan = style.getPropertyValue('--node-orphan').trim() || '#898781';
  const edgeColor = style.getPropertyValue('--edge').trim() || '#c3c2b7';
  const edgeMutual = style.getPropertyValue('--edge-mutual').trim() || '#52514e';
  const textColor = style.getPropertyValue('--text-1').trim() || '#0b0b0b';

  let query = '';

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    for (const l of links) {
      const p1 = worldToScreen(l.a.x, l.a.y);
      const p2 = worldToScreen(l.b.x, l.b.y);
      const dimmed = query && !(matchesQuery(l.a) || matchesQuery(l.b));
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = l.mutual ? edgeMutual : edgeColor;
      ctx.globalAlpha = dimmed ? 0.08 : (l.mutual ? 0.55 : 0.35);
      ctx.lineWidth = (l.mutual ? 1.6 : 1) * Math.min(1.4, camK);
      ctx.stroke();

      if (!l.mutual) {
        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const edgeR = 8 * camK;
        const ax = p2.x - Math.cos(angle) * (l.b.r * camK + 4);
        const ay = p2.y - Math.sin(angle) * (l.b.r * camK + 4);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(angle - 0.4) * 6, ay - Math.sin(angle - 0.4) * 6);
        ctx.lineTo(ax - Math.cos(angle + 0.4) * 6, ay - Math.sin(angle + 0.4) * 6);
        ctx.closePath();
        ctx.fillStyle = edgeColor;
        ctx.globalAlpha = dimmed ? 0.08 : 0.5;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    for (const n of nodes) {
      const p = worldToScreen(n.x, n.y);
      const r = n.r * camK;
      const dimmed = query && !matchesQuery(n);
      ctx.globalAlpha = dimmed ? 0.15 : 1;

      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (n.isOrphan) {
        ctx.fillStyle = nodeOrphan;
        ctx.globalAlpha = (dimmed ? 0.15 : 1) * 0.5;
        ctx.fill();
        ctx.globalAlpha = dimmed ? 0.15 : 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = nodeOrphan;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = lerpColor(nodeLo, nodeHi, colorForStrength(n.strength ?? 0.5));
        ctx.fill();
        if (n === hovered) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = textColor;
          ctx.stroke();
        }
      }

      if (camK > 0.9 && !dimmed) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = textColor;
        ctx.font = (11) + 'px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        const label = n.label.length > 28 ? n.label.slice(0, 28) + '…' : n.label;
        ctx.fillText(label, p.x + r + 6, p.y);
      }
    }
    ctx.globalAlpha = 1;
  }

  function matchesQuery(n) {
    if (!query) return true;
    return n.content.toLowerCase().includes(query) || n.label.toLowerCase().includes(query);
  }

  function loop() {
    tick();
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // --- interaction ---
  let hovered = null;

  function nodeAtScreen(sx, sy) {
    const w = screenToWorld(sx, sy);
    let closest = null;
    let closestDist = Infinity;
    for (const n of nodes) {
      const dx = n.x - w.x;
      const dy = n.y - w.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= n.r + 3 / camK && dist < closestDist) {
        closest = n;
        closestDist = dist;
      }
    }
    return closest;
  }

  canvas.addEventListener('mousedown', e => {
    const hit = nodeAtScreen(e.clientX, e.clientY);
    if (hit) {
      dragging = hit;
      hit.fx = hit.x; hit.fy = hit.y;
      reheat();
    } else {
      dragging = 'pan';
      panStart = { x: e.clientX, y: e.clientY, camX, camY };
      canvas.classList.add('dragging');
    }
  });

  window.addEventListener('mousemove', e => {
    if (dragging === 'pan') {
      camX = panStart.camX - (e.clientX - panStart.x) / camK;
      camY = panStart.camY - (e.clientY - panStart.y) / camK;
    } else if (dragging) {
      const w = screenToWorld(e.clientX, e.clientY);
      dragging.fx = w.x; dragging.fy = w.y;
      reheat();
    } else {
      const hit = nodeAtScreen(e.clientX, e.clientY);
      if (hit !== hovered) {
        hovered = hit;
        if (hit) {
          const strengthText = hit.strength !== undefined ? hit.strength.toFixed(2) : 'n/a';
          tooltip.innerHTML = escapeHtml(hit.content) +
            '<div class="stats">strength ' + strengthText +
            ' · retrieved ' + hit.retrievalCount + 'x · ' + hit.degree + ' link' + (hit.degree === 1 ? '' : 's') +
            ' · created ' + escapeHtml(hit.createdAgo) + '</div>';
          tooltip.classList.add('visible');
        } else {
          tooltip.classList.remove('visible');
        }
      }
      if (hit) {
        tooltip.style.left = Math.min(e.clientX + 16, width - 340) + 'px';
        tooltip.style.top = Math.min(e.clientY + 16, height - 100) + 'px';
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (dragging && dragging !== 'pan') {
      dragging.fx = null; dragging.fy = null;
    }
    dragging = null;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const before = screenToWorld(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.001);
    camK = Math.min(4, Math.max(0.15, camK * factor));
    const after = screenToWorld(e.clientX, e.clientY);
    camX += before.x - after.x;
    camY += before.y - after.y;
  }, { passive: false });

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
  });

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
}
</script>
</body>
</html>
`;
}
