import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { bracketMatching, foldGutter, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { tags } from "@lezer/highlight";

const state = { graph: { modules: [], edges: [] }, traces: [], hot: new Set(), selectedTrace: null, showTests: false };
const $ = (selector) => document.querySelector(selector);
const map = $("#map"), mapContent = $("#map-content"), mapScene = $("#map-scene"), nodes = $("#nodes"), canvas = $("#edges"), detail = $("#detail"), tracesEl = $("#traces"), summary = $("#map-summary"), sourceDialog = $("#source-dialog");
const api = (path, options) => fetch(path, options).then((response) => response.json());
const duration = (value) => value < 1000 ? Math.round(value) + "ms" : (value / 1000).toFixed(2) + "s";
const text = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
const elk = globalThis.ELK ? new globalThis.ELK() : null;
let layoutRevision = 0;
let clearReset;
let sourceViewer;
const zoom = { value: 1, min: 0.4, max: 2, step: 0.1, width: 0, height: 0, available: false };
const mountedViewers = new WeakMap();
const atlasHighlight = HighlightStyle.define([
  { tag: tags.comment, color: "oklch(.59 .018 255)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: "oklch(.72 .16 35.8)" },
  { tag: [tags.string, tags.special(tags.string)], color: "oklch(.78 .12 142)" },
  { tag: [tags.number, tags.bool, tags.null], color: "oklch(.78 .13 75)" },
  { tag: [tags.propertyName, tags.attributeName], color: "oklch(.78 .07 255)" },
  { tag: [tags.typeName, tags.className], color: "oklch(.78 .09 205)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "oklch(.86 .06 255)" },
  { tag: [tags.punctuation, tags.bracket], color: "oklch(.68 .02 255)" },
  { tag: tags.invalid, color: "var(--danger)", textDecoration: "underline" },
]);
const atlasViewerTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--ink)", backgroundColor: "transparent", fontSize: "11px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { padding: "9px 0", caretColor: "transparent" },
  ".cm-line": { padding: "0 11px" },
  ".cm-gutters": { color: "var(--muted)", backgroundColor: "transparent", border: "0" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "38px", padding: "0 8px 0 6px" },
  ".cm-foldGutter .cm-gutterElement": { width: "15px", color: "var(--muted)", cursor: "pointer" },
  ".cm-definition-line": { backgroundColor: "color-mix(in oklch, var(--raised), var(--live) 13%)", boxShadow: "inset 2px 0 var(--live)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in oklch, var(--live), transparent 72%)" },
}, { dark: true });

function languageFor(module) {
  if (/\.json$/i.test(module)) return json();
  if (/\.tsx$/i.test(module)) return javascript({ typescript: true, jsx: true });
  if (/\.ts$/i.test(module)) return javascript({ typescript: true });
  if (/\.jsx$/i.test(module)) return javascript({ jsx: true });
  return javascript();
}
function valueForViewer(value) {
  if (value === null || value === undefined || value === "") return { doc: "—" };
  try { return { doc: JSON.stringify(JSON.parse(value), null, 2), language: json() }; }
  catch { return { doc: String(value) }; }
}
function mountViewer(parent, doc, options = {}) {
  parent.dataset.codeViewer = "true";
  const extensions = [
    EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: "0" }),
    lineNumbers(options.lineStart ? { formatNumber: (line) => String(options.lineStart + line - 1) } : undefined),
    foldGutter(), highlightSpecialChars(), bracketMatching(), syntaxHighlighting(atlasHighlight), atlasViewerTheme,
  ];
  if (options.language) extensions.push(options.language);
  if (options.wrap) extensions.push(EditorView.lineWrapping);
  if (options.definition) extensions.push(EditorView.decorations.of(Decoration.set([Decoration.line({ attributes: { class: "cm-definition-line" } }).range(0)])));
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  mountedViewers.set(parent, view);
  return view;
}
function disposeViewers(container) {
  container.querySelectorAll("[data-code-viewer]").forEach((host) => { mountedViewers.get(host)?.destroy(); mountedViewers.delete(host); });
}
function replaceDetail(section) { disposeViewers(detail); detail.replaceChildren(section); }
function clampZoom(value) { return Math.min(zoom.max, Math.max(zoom.min, value)); }
function updateZoomSurface() {
  mapScene.style.width = zoom.width + "px";
  mapScene.style.height = zoom.height + "px";
  mapScene.style.transform = "scale(" + zoom.value + ")";
  mapContent.style.width = Math.max(map.clientWidth, zoom.width * zoom.value) + "px";
  mapContent.style.height = Math.max(map.clientHeight, zoom.height * zoom.value) + "px";
  $("#zoom-level").textContent = Math.round(zoom.value * 100) + "%";
  $("#zoom-out").disabled = !zoom.available || zoom.value <= zoom.min;
  $("#zoom-in").disabled = !zoom.available || zoom.value >= zoom.max;
}
function setZoom(value, anchor = { x: map.clientWidth / 2, y: map.clientHeight / 2 }) {
  const next = clampZoom(value);
  const contentX = (map.scrollLeft + anchor.x) / zoom.value;
  const contentY = (map.scrollTop + anchor.y) / zoom.value;
  zoom.value = next;
  updateZoomSurface();
  map.scrollTo(contentX * next - anchor.x, contentY * next - anchor.y);
}
function setZoomLayout(width, height, available) {
  zoom.width = width;
  zoom.height = height;
  zoom.available = available;
  updateZoomSurface();
}

async function refresh() { [state.graph, state.traces] = await Promise.all([api("/api/graph"), api("/api/traces")]); render(); }
function render() { renderTraces(); renderMap(); }
function renderTraces() {
  tracesEl.replaceChildren();
  if (!state.traces.length) { tracesEl.append(text("li", "Waiting for the first call.", "empty")); return; }
  state.traces.forEach((trace) => {
    const button = document.createElement("button"); button.dataset.trace = trace.traceId; if (state.selectedTrace === trace.traceId) button.classList.add("active");
    button.append(text("span", trace.traceId.slice(0, 16), "trace-name"));
    const meta = document.createElement("span"); meta.className = "trace-meta"; meta.append(text("span", trace.spans + " spans · " + duration(trace.duration)));
    if (trace.errors) meta.append(text("span", trace.errors + " error", "bad")); button.append(meta);
    const item = document.createElement("li"); item.append(button); tracesEl.append(item);
  });
}
function fallbackLayout(modules, edges) {
  const sorted = [...modules].sort((a, b) => a.module.localeCompare(b.module)); const level = new Map(sorted.map((module) => [module.module, 0]));
  for (let pass = 0; pass < sorted.length; pass++) edges.forEach((edge) => { if (edge.source !== edge.target) level.set(edge.target, Math.max(level.get(edge.target) || 0, (level.get(edge.source) || 0) + 1)); });
  const columns = new Map(); sorted.forEach((module) => { const key = level.get(module.module) || 0; columns.set(key, [...(columns.get(key) || []), module]); });
  const positions = new Map(); [...columns.keys()].sort((a, b) => a - b).forEach((column) => columns.get(column).sort((a, b) => a.module.localeCompare(b.module)).forEach((module, row) => positions.set(module.module, { left: 32 + column * 250, top: 30 + row * 116 })));
  return { positions, width: Math.max(720, columns.size * 250 + 48), height: Math.max(440, ...[...positions.values()].map((position) => position.top + 120)) };
}
async function layout(modules, edges) {
  if (!elk) return fallbackLayout(modules, edges);
  const graph = await elk.layout({
    id: "atlas",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "46",
    },
    children: modules.map((module) => ({ id: module.module, width: 204, height: 88 })),
    edges: edges.filter((edge) => edge.source !== edge.target).map((edge) => ({ id: edge.source + "->" + edge.target, sources: [edge.source], targets: [edge.target] })),
  });
  const positions = new Map((graph.children || []).map((child) => [child.id, { left: (child.x || 0) + 32, top: (child.y || 0) + 30 }]));
  return { positions, width: Math.max(720, (graph.width || 0) + 64), height: Math.max(440, (graph.height || 0) + 60) };
}
async function renderMap() {
  const revision = ++layoutRevision;
  const testCount = state.graph.modules.filter((module) => module.test).length;
  const modules = state.graph.modules.filter((module) => state.showTests || !module.test);
  const visible = new Set(modules.map((module) => module.module));
  const edges = state.graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));
  const testToggle = $("#show-tests"); testToggle.disabled = testCount === 0; $("#show-tests-label").textContent = "Show tests" + (testCount ? " (" + testCount + ")" : "");
  summary.textContent = modules.length ? modules.length + " modules · " + edges.length + " overlay edges" : "No modules observed yet";
  $("#empty-map").hidden = !!modules.length; nodes.replaceChildren(); if (!modules.length) { setZoomLayout(0, 0, false); return; }
  const result = await layout(modules, edges); if (revision !== layoutRevision) return;
  result.edges = edges;
  nodes.style.width = result.width + "px"; nodes.style.height = result.height + "px";
  setZoomLayout(result.width, result.height, true);
  modules.forEach((module) => {
    const position = result.positions.get(module.module), button = document.createElement("button"), parts = module.module.split("/");
    button.className = "module" + (state.hot.has(module.module) ? " hot" : ""); button.dataset.module = module.module; button.style.left = position.left + "px"; button.style.top = position.top + "px";
    button.append(text("span", parts.slice(0, -1).join("/") || "project root", "module-dir"), text("span", parts.at(-1), "module-path"));
    const info = document.createElement("span"); info.className = "module-info"; info.append(text("span", module.calls + " calls"));
    if (module.callsPerMinute) info.append(text("span", module.callsPerMinute + "/min")); if (module.errors) info.append(text("span", module.errors + " errors", "problem")); if (module.changedDescription) info.append(text("span", "changed", "changed"));
    button.append(info); nodes.append(button);
  }); requestAnimationFrame(() => drawEdges(result));
}
function drawEdges(layoutResult) {
  const width = layoutResult.width, height = layoutResult.height, scale = devicePixelRatio, context = canvas.getContext("2d"); canvas.width = width * scale; canvas.height = height * scale; canvas.style.width = width + "px"; canvas.style.height = height + "px"; context.scale(scale, scale); context.clearRect(0, 0, width, height);
  layoutResult.edges.forEach((edge) => {
    const from = layoutResult.positions.get(edge.source), to = layoutResult.positions.get(edge.target); if (!from || !to) return;
    const same = edge.source === edge.target, x1 = from.left + 204, y1 = from.top + 43, x2 = same ? from.left + 204 : to.left, y2 = same ? from.top + 78 : to.top + 43;
    context.save(); context.lineWidth = Math.min(4, 1 + Math.log2(edge.calls + 1)); context.strokeStyle = edge.kind === "rogue" ? "rgba(239,83,80,.85)" : edge.kind === "ghost" ? "rgba(146,152,170,.55)" : "rgba(225,111,64,.7)";
    if (edge.kind === "ghost") context.setLineDash([5, 5]); context.beginPath(); context.moveTo(x1, y1);
    if (same) context.bezierCurveTo(x1 + 36, y1, x1 + 36, y2, x2, y2); else context.bezierCurveTo(x1 + 22, y1, x2 - 22, y2, x2, y2); context.stroke(); context.restore();
  });
}
async function showSource(module, fn) {
  const source = await api("/api/source?module=" + encodeURIComponent(module) + "&fn=" + encodeURIComponent(fn));
  if (!source.available) return;
  $("#source-title").textContent = source.fn;
  $("#source-location").textContent = source.module + ":" + source.location.line + ":" + source.location.column;
  const code = $("#source-code"); sourceViewer?.destroy(); code.replaceChildren();
  sourceDialog.showModal();
  sourceViewer = mountViewer(code, source.source, { language: languageFor(source.module), lineStart: source.location.line, definition: true });
  requestAnimationFrame(() => sourceViewer?.requestMeasure());
}
function descriptionBlock(info, module, fn) {
  const section = document.createElement("section"); section.className = "description"; section.append(text("h3", "Intent"));
  if (info.description) section.append(text("p", info.description));
  else section.append(text("p", info.stale ? "Source changed since its last description." : "No description generated.", "muted"));
  const actions = document.createElement("div"); actions.className = "description-actions";
  const sourceButton = text("button", "Open source", "source-link"); sourceButton.addEventListener("click", () => showSource(module, fn)); actions.append(sourceButton);
  if (!info.description) { const button = text("button", "Generate description", "generate"); button.addEventListener("click", async () => { button.textContent = "Generating…"; const next = await api("/api/descriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ module, fn }) }); section.replaceWith(descriptionBlock(next, module, fn)); }); actions.append(button); }
  section.append(actions);
  return section;
}
async function showTrace(traceId) {
  state.selectedTrace = traceId; renderTraces(); const data = await api("/api/traces/" + encodeURIComponent(traceId)), spans = data.spans;
  const section = document.createElement("section"); section.append(text("h2", "Trace evidence"), text("div", traceId, "sub"), text("h3", spans.length + " spans"));
  const tree = document.createElement("ol"); tree.className = "span-tree"; const byId = new Map(spans.map((span) => [span.spanId, span]));
  spans.forEach((span) => { let depth = 0, parent = span; while (parent.parentId && byId.has(parent.parentId)) { parent = byId.get(parent.parentId); depth++; } const button = document.createElement("button"); button.dataset.span = span.spanId; button.style.setProperty("--depth", depth); button.append(text("strong", span.fn), document.createElement("br"), text("code", span.module), document.createTextNode(" · " + duration(span.t1 - span.t0) + (span.error ? " · error" : ""))); const item = document.createElement("li"); item.append(button); tree.append(item); }); section.append(tree); replaceDetail(section);
}
async function showSpan(spanId) {
  const span = await api("/api/spans/" + encodeURIComponent(spanId)); const info = await api("/api/descriptions?module=" + encodeURIComponent(span.module) + "&fn=" + encodeURIComponent(span.fn));
  const args = valueForViewer(span.args), result = span.error ? { doc: span.error } : valueForViewer(span.result);
  const argsHost = document.createElement("div"), resultHost = document.createElement("div");
  argsHost.className = "value code-viewer"; resultHost.className = "value code-viewer" + (span.error ? " error-text" : "");
  const section = document.createElement("section"); section.append(text("h2", span.fn), text("div", span.module, "sub"), text("div", duration(span.t1 - span.t0) + " · span " + span.spanId, "sub"), descriptionBlock(info, span.module, span.fn), text("h3", "Arguments"), argsHost, text("h3", span.error ? "Error" : "Result"), resultHost);
  replaceDetail(section); mountViewer(argsHost, args.doc, { language: args.language, wrap: true }); mountViewer(resultHost, result.doc, { language: result.language, wrap: true });
}
async function showModule(module) {
  const rows = await api("/api/functions/" + encodeURIComponent(module)); const section = document.createElement("section"); section.append(text("h2", "Module functions"), text("div", module, "sub"), text("h3", "Observed functions"));
  if (!rows.length) section.append(text("p", "No function spans yet.", "muted"));
  rows.forEach((row) => {
    const item = document.createElement("div"); item.className = "function-row"; const button = document.createElement("button"); button.addEventListener("click", () => showFunction(module, row));
    button.append(text("strong", row.fn), text("div", row.calls + " calls · p50 " + duration(row.p50) + " · p95 " + duration(row.p95) + (row.errors ? " · " + row.errors + " errors" : ""), "function-meta")); item.append(button);
    const recent = document.createElement("div"); recent.className = "recent"; row.recent.forEach((entry) => { const trace = text("button", entry.traceId.slice(0, 8) + " " + duration(entry.duration)); trace.addEventListener("click", () => showTrace(entry.traceId)); recent.append(trace); }); item.append(recent); section.append(item);
  }); replaceDetail(section);
}
function showFunction(module, row) {
  const section = document.createElement("section"); section.append(text("h2", row.fn), text("div", module, "sub"), descriptionBlock(row.description, module, row.fn), text("h3", "Observed behavior"), text("div", row.calls + " calls · p50 " + duration(row.p50) + " · p95 " + duration(row.p95) + " · " + Math.round(row.errorRate * 100) + "% error rate", "muted")); replaceDetail(section);
}
document.addEventListener("click", (event) => { const target = event.target.closest("[data-trace],[data-span],[data-module]"); if (!target) return; if (target.dataset.trace) showTrace(target.dataset.trace); if (target.dataset.span) showSpan(target.dataset.span); if (target.dataset.module) showModule(target.dataset.module); });
$("#refresh").addEventListener("click", refresh); $("#refresh-graph").addEventListener("click", async () => { await api("/api/graph/refresh", { method: "POST" }); refresh(); }); window.addEventListener("resize", renderMap);
$("#zoom-out").addEventListener("click", () => setZoom(zoom.value - zoom.step));
$("#zoom-in").addEventListener("click", () => setZoom(zoom.value + zoom.step));
map.addEventListener("wheel", (event) => {
  if (!zoom.available) return;
  const pinch = event.ctrlKey || event.metaKey;
  const mouseWheel = event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || Math.abs(event.deltaY) >= 40;
  if (!pinch && !mouseWheel) return;
  event.preventDefault();
  const bounds = map.getBoundingClientRect();
  const sensitivity = pinch ? 0.01 : 0.0025;
  setZoom(zoom.value * Math.exp(-event.deltaY * sensitivity), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
}, { passive: false });
$("#clear-traces").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!button.classList.contains("confirm")) {
    button.classList.add("confirm"); button.textContent = "Clear?";
    clearTimeout(clearReset); clearReset = setTimeout(() => { button.classList.remove("confirm"); button.textContent = "Clear"; }, 3000);
    return;
  }
  clearTimeout(clearReset); button.disabled = true; button.textContent = "Clearing…";
  const result = await api("/api/traces", { method: "DELETE" });
  state.selectedTrace = null; state.hot.clear(); disposeViewers(detail); detail.replaceChildren(text("div", result.deletedTraces ? result.deletedTraces + " traces cleared." : "No traces to clear.", "detail-placeholder"));
  button.classList.remove("confirm"); button.disabled = false; button.textContent = "Clear"; await refresh();
});
$("#show-tests").addEventListener("change", (event) => { state.showTests = event.target.checked; renderMap(); });
function closeSource() { sourceViewer?.destroy(); sourceViewer = undefined; $("#source-code").replaceChildren(); sourceDialog.close(); }
$("#close-source").addEventListener("click", closeSource); sourceDialog.addEventListener("click", (event) => { if (event.target === sourceDialog) closeSource(); });
const socket = new WebSocket((location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/ws");
socket.addEventListener("open", () => { $("#connection").textContent = "live"; $("#connection").classList.add("connected"); });
socket.addEventListener("message", ({ data }) => { JSON.parse(data).events.forEach((event) => state.hot.add(event.module)); refresh(); setTimeout(() => { state.hot.clear(); renderMap(); }, 1500); });
socket.addEventListener("close", () => { $("#connection").textContent = "reconnecting"; $("#connection").classList.remove("connected"); });
refresh();
