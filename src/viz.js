// Build the graph data shape from the IndexedDB stores + render it via D3.
//
// Browser: relies on globalThis.d3 (loaded via @require in the userscript)
// and `graphologyLibrary.communitiesLouvain` for community detection.
// We accept either the `graphology` + `graphology-communities-louvain` libs,
// OR a fallback `componentLouvain` function that just labels each connected
// component as its own community (useful when graphology isn't loaded).

import { listEdges, listMutuals, getUser } from "./db.js";

// Pure: produce GraphData from raw nodes/edges arrays + a louvain function.
export function buildGraphData(rawNodes, rawEdges, {
  minDegree = 0, sizeExponent = 0.6, louvain = componentLouvain,
} = {}) {
  // Build adjacency to compute degrees + connected components / communities.
  const adj = new Map();
  for (const n of rawNodes) adj.set(n.id, new Set());
  // Dedup undirected edges: store as min/max key.
  const edgeSet = new Set();
  for (const e of rawEdges) {
    if (!adj.has(e.source_id) || !adj.has(e.target_id)) continue;
    const a = e.source_id < e.target_id ? e.source_id : e.target_id;
    const b = e.source_id < e.target_id ? e.target_id : e.source_id;
    const key = `${a}|${b}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    adj.get(a).add(b);
    adj.get(b).add(a);
  }

  // Apply min-degree filter.
  if (minDegree > 0) {
    for (const [id, neigh] of adj) {
      if (neigh.size < minDegree) {
        adj.delete(id);
        for (const other of neigh) adj.get(other)?.delete(id);
      }
    }
  }

  if (adj.size === 0) return { nodes: [], edges: [] };

  // Communities (deterministic — caller's louvain decides the algorithm).
  const community = louvain(adj);

  const nodes = [];
  for (const [id, neigh] of adj) {
    const raw = rawNodes.find((n) => n.id === id) || {};
    const deg = neigh.size;
    nodes.push({
      id,
      handle: raw.handle ?? null,
      name: raw.name ?? null,
      bio: raw.bio ?? null,
      followers_count: raw.followers_count ?? null,
      degree: deg,
      community: community.get(id) ?? 0,
      size: Math.round((5 + Math.pow(deg, sizeExponent) * 5) * 1000) / 1000,
    });
  }

  const edges = [];
  for (const key of edgeSet) {
    const [s, t] = key.split("|");
    if (adj.has(s) && adj.has(t)) edges.push({ source: s, target: t });
  }

  nodes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  edges.sort((a, b) => (a.source + a.target).localeCompare(b.source + b.target));
  return { nodes, edges };
}

// Fallback "louvain" implementation: each connected component = one community.
// Deterministic; good enough when graphology isn't loaded.
export function componentLouvain(adj) {
  const out = new Map();
  let cid = 0;
  // Visit nodes in sorted id order for determinism.
  const ids = [...adj.keys()].sort();
  const visited = new Set();
  for (const start of ids) {
    if (visited.has(start)) continue;
    const queue = [start];
    while (queue.length) {
      const n = queue.shift();
      if (visited.has(n)) continue;
      visited.add(n);
      out.set(n, cid);
      for (const nb of adj.get(n) ?? []) if (!visited.has(nb)) queue.push(nb);
    }
    cid += 1;
  }
  return out;
}

// Wrapper that tries the real graphology Louvain when available.
export function realLouvain(adj, { seed = 42 } = {}) {
  const G = globalThis.graphology;
  const louvainLib = globalThis.graphologyLibrary?.communitiesLouvain;
  if (!G || !louvainLib) return componentLouvain(adj);
  const g = new G.UndirectedGraph();
  for (const id of adj.keys()) g.addNode(id);
  for (const [a, neigh] of adj) {
    for (const b of neigh) {
      if (a < b && !g.hasEdge(a, b)) g.addEdge(a, b);
    }
  }
  const detail = louvainLib.detailed(g, { rng: () => seedRandom(seed)() });
  const out = new Map();
  for (const [id, cid] of Object.entries(detail.communities)) out.set(id, cid);
  return out;
}

// Tiny seeded PRNG (mulberry32) to feed deterministic randomness into Louvain.
function seedRandom(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Load nodes + edges from IndexedDB and build the graph data.
export async function buildGraphFromDb(db, opts = {}) {
  const seed = await listMutuals(db);
  const rawNodes = [];
  for (const id of seed) {
    const u = await getUser(db, id);
    if (u) rawNodes.push(u);
  }
  const rawEdges = await listEdges(db);
  return buildGraphData(rawNodes, rawEdges, { louvain: realLouvain, ...opts });
}

// Render the D3 force-directed graph into a container element.
// Browser-only: requires globalThis.d3.
export function renderGraph(container, graph) {
  const d3 = globalThis.d3;
  if (!d3) {
    container.innerHTML =
      `<p style="color:#999;padding:20px">D3 not loaded (check @require lines).</p>`;
    return;
  }
  container.innerHTML = "";
  if (graph.nodes.length === 0) {
    container.innerHTML =
      `<p style="color:#888;padding:20px">No data yet — run the pipeline first.</p>`;
    return;
  }

  const w = container.clientWidth || 900;
  const h = container.clientHeight || 600;
  const svg = d3.select(container).append("svg")
    .attr("viewBox", [0, 0, w, h]).attr("width", "100%").attr("height", "100%");
  const g = svg.append("g");

  const palette = d3.schemeTableau10.concat(d3.schemeSet3 || []);
  const color = (c) => palette[c % palette.length];

  // HTML escape — userscript runs as the x.com origin with the user's full
  // session cookies, so any HTML injected via a malicious handle/name/bio is
  // a real session-takeover XSS. Escape every interpolated value.
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  const sim = d3.forceSimulation(graph.nodes)
    .force("link", d3.forceLink(graph.edges).id((d) => d.id).distance(60).strength(0.4))
    .force("charge", d3.forceManyBody().strength(-90))
    .force("center", d3.forceCenter(w / 2, h / 2))
    .force("collide", d3.forceCollide().radius((d) => d.size + 2));

  const link = g.append("g").attr("stroke", "#444").attr("stroke-opacity", 0.5)
    .selectAll("line").data(graph.edges).join("line");

  const tip = d3.select(container).append("div")
    .attr("class", "mm-tooltip")
    .style("position", "absolute").style("opacity", 0)
    .style("pointer-events", "none")
    .style("background", "rgba(20,20,24,0.95)").style("color", "#eee")
    .style("border", "1px solid #444").style("border-radius", "4px")
    .style("padding", "8px 10px").style("font-size", "12px");

  const node = g.append("g").selectAll("circle").data(graph.nodes).join("circle")
    .attr("r", (d) => d.size).attr("fill", (d) => color(d.community))
    .attr("stroke", "#000").attr("stroke-width", 0.5).style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag",  (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on("end",   (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on("mouseover", (event, d) => {
      tip.style("opacity", 1).html(
        `<strong>@${escapeHtml(d.handle ?? "?")}</strong> &mdash; ${escapeHtml(d.name ?? "")}<br>` +
        `${escapeHtml(d.bio ?? "")}<br>` +
        `<small>followers: ${escapeHtml(d.followers_count ?? "?")} · ` +
        `degree: ${escapeHtml(d.degree)} · community: ${escapeHtml(d.community)}</small>`
      ).style("left", (event.offsetX + 10) + "px").style("top", (event.offsetY + 10) + "px");
    })
    .on("mouseout", () => tip.style("opacity", 0))
    .on("click", (event, d) => {
      // URL-encode the handle so a malicious value can't break out of the URL.
      if (d.handle) window.open(`https://x.com/${encodeURIComponent(d.handle)}`, "_blank");
    });

  sim.on("tick", () => {
    link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
    node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
  });

  svg.call(d3.zoom().scaleExtent([0.1, 8]).on("zoom", (e) => g.attr("transform", e.transform)));
}
