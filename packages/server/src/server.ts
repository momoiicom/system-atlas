import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { descriptionState, discoverFunctions, generateDescription, sourceForFunction } from "./descriptions.js";
import { atlasFileConfig } from "./llm-config.js";
import { refreshStaticGraph } from "./static-graph.js";
import { isTestModule } from "./source-files.js";

type EventRow = { rowid: number; trace_id: string; span_id: string; parent_id: string | null; module: string; fn: string; t0: number; t1: number; args: string | null; result: string | null; error: string | null; };
type RuntimeEdge = { source: string; target: string; calls: number };
type StaticEdge = { source: string; target: string };

function asEvent(row: EventRow) { return { rowid: row.rowid, traceId: row.trace_id, spanId: row.span_id, parentId: row.parent_id, module: row.module, fn: row.fn, t0: row.t0, t1: row.t1, args: row.args, result: row.result, error: row.error }; }
function edgeKey(source: string, target: string) { return source + "\0" + target; }
function withoutSource<T extends { source?: unknown }>(value: T) { const { source, ...rest } = value; return rest; }

export function openAtlasDb(projectRoot = process.cwd()): Database.Database {
  const dbPath = resolve(projectRoot, process.env.ATLAS_DB_PATH || atlasFileConfig(projectRoot).dbPath || ".atlas/atlas.db");
  if (!existsSync(dbPath)) throw new Error("No Atlas database at " + dbPath + ". Start the instrumented app once first.");
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  return db;
}

export function clearTraceEvents(db: Database.Database) {
  const counts = db.prepare("SELECT COUNT(DISTINCT trace_id) AS traces, COUNT(*) AS spans FROM events").get() as { traces: number; spans: number };
  db.prepare("DELETE FROM events").run();
  return { deletedTraces: counts.traces, deletedSpans: counts.spans };
}

function graphPayload(db: Database.Database, projectRoot: string) {
  const runtime = db.prepare("SELECT parent.module AS source, child.module AS target, COUNT(*) AS calls FROM events child JOIN events parent ON parent.trace_id = child.trace_id AND parent.span_id = child.parent_id GROUP BY parent.module, child.module").all() as RuntimeEdge[];
  const statics = db.prepare("SELECT from_module AS source, to_module AS target FROM static_graph").all() as StaticEdge[];
  const runtimeByEdge = new Map(runtime.map((edge) => [edgeKey(edge.source, edge.target), edge]));
  const staticByEdge = new Map(statics.map((edge) => [edgeKey(edge.source, edge.target), edge]));
  const edgeKeys = new Set([...runtimeByEdge.keys(), ...staticByEdge.keys()]);
  const edges = [...edgeKeys].map((key) => {
    const runtimeEdge = runtimeByEdge.get(key);
    const staticEdge = staticByEdge.get(key);
    const source = runtimeEdge?.source ?? staticEdge!.source;
    const target = runtimeEdge?.target ?? staticEdge!.target;
    return { source, target, calls: runtimeEdge?.calls ?? 0, kind: runtimeEdge && staticEdge ? "live" : runtimeEdge ? "rogue" : "ghost" };
  }).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const observed = db.prepare("SELECT module, COUNT(*) AS calls, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors, SUM(CASE WHEN t1 >= ? THEN 1 ELSE 0 END) AS callsPerMinute, MAX(t1) AS lastSeen FROM events GROUP BY module").all(Date.now() - 60_000) as Array<{ module: string; calls: number; errors: number; callsPerMinute: number; lastSeen: number }>;
  const allModules = new Set([...observed.map((entry) => entry.module), ...statics.flatMap((edge) => [edge.source, edge.target])]);
  const moduleByName = new Map(observed.map((entry) => [entry.module, entry]));
  const staleFunctions = db.prepare("SELECT DISTINCT module, fn FROM events").all() as Array<{ module: string; fn: string }>;
  const staleByModule = new Set(staleFunctions.filter((entry) => descriptionState(db, projectRoot, entry.module, entry.fn).stale).map((entry) => entry.module));
  const modules = [...allModules].sort().map((module) => ({ module, test: isTestModule(module), calls: moduleByName.get(module)?.calls ?? 0, errors: moduleByName.get(module)?.errors ?? 0, callsPerMinute: moduleByName.get(module)?.callsPerMinute ?? 0, changedDescription: staleByModule.has(module), lastSeen: moduleByName.get(module)?.lastSeen ?? null }));
  return { modules, edges };
}

function functionMetrics(db: Database.Database, projectRoot: string, module: string) {
  const rows = db.prepare("SELECT fn, t0, t1, error, trace_id FROM events WHERE module = ? ORDER BY t1 DESC").all(module) as Array<{ fn: string; t0: number; t1: number; error: string | null; trace_id: string }>;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) groups.set(row.fn, [...(groups.get(row.fn) ?? []), row]);
  const functions = new Set([...groups.keys(), ...discoverFunctions(projectRoot, module).map((entry) => entry.fn)]);
  return [...functions].map((fn) => {
    const entries = groups.get(fn) ?? [];
    const timings = entries.map((entry) => entry.t1 - entry.t0).sort((a, b) => a - b);
    const percentile = (fraction: number) => timings[Math.max(0, Math.ceil(timings.length * fraction) - 1)] ?? 0;
    const state = descriptionState(db, projectRoot, module, fn);
    return {
      fn,
      calls: entries.length,
      errors: entries.filter((entry) => entry.error).length,
      errorRate: entries.length ? entries.filter((entry) => entry.error).length / entries.length : 0,
      p50: percentile(0.5),
      p95: percentile(0.95),
      recent: entries.slice(0, 12).map((entry) => ({ traceId: entry.trace_id, t0: entry.t0, duration: entry.t1 - entry.t0, error: !!entry.error })),
      description: withoutSource(state),
    };
  }).sort((a, b) => b.calls - a.calls || a.fn.localeCompare(b.fn));
}

export async function createAtlasServer(projectRoot = process.cwd(), port = 4400) {
  const db = openAtlasDb(projectRoot);
  const app = Fastify({ logger: false });
  const clients = new Set<any>();
  let lastRow = (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS max FROM events").get() as { max: number }).max;
  refreshStaticGraph(db, projectRoot);

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: new URL("./ui/", import.meta.url).pathname, prefix: "/" });
  app.get("/api/graph", async () => graphPayload(db, projectRoot));
  app.post("/api/graph/refresh", async () => ({ ...refreshStaticGraph(db, projectRoot), graph: graphPayload(db, projectRoot) }));
  app.get("/api/traces", async () => db.prepare("SELECT trace_id AS traceId, MIN(t0) AS startedAt, MAX(t1) - MIN(t0) AS duration, COUNT(*) AS spans, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors FROM events GROUP BY trace_id ORDER BY startedAt DESC LIMIT 40").all());
  app.delete("/api/traces", async () => clearTraceEvents(db));
  app.get<{ Params: { traceId: string } }>("/api/traces/:traceId", async (request) => ({ spans: (db.prepare("SELECT rowid, trace_id, span_id, parent_id, module, fn, t0, t1, args, result, error FROM events WHERE trace_id = ? ORDER BY t0, rowid").all(request.params.traceId) as EventRow[]).map(asEvent) }));
  app.get<{ Params: { spanId: string } }>("/api/spans/:spanId", async (request, reply) => { const span = db.prepare("SELECT rowid, trace_id, span_id, parent_id, module, fn, t0, t1, args, result, error FROM events WHERE span_id = ? ORDER BY rowid DESC LIMIT 1").get(request.params.spanId) as EventRow | undefined; return span ? asEvent(span) : reply.code(404).send({ error: "Span not found" }); });
  app.get<{ Params: { module: string } }>("/api/functions/:module", async (request) => functionMetrics(db, projectRoot, request.params.module));
  app.get<{ Querystring: { module?: string; fn?: string } }>("/api/descriptions", async (request, reply) => {
    if (!request.query.module || !request.query.fn) return reply.code(400).send({ error: "module and fn are required" });
    return withoutSource(descriptionState(db, projectRoot, request.query.module, request.query.fn));
  });
  app.get<{ Querystring: { module?: string; fn?: string } }>("/api/source", async (request, reply) => {
    if (!request.query.module || !request.query.fn) return reply.code(400).send({ error: "module and fn are required" });
    const source = sourceForFunction(projectRoot, request.query.module, request.query.fn);
    return source.available ? source : reply.code(404).send({ error: "Source not found" });
  });
  app.post<{ Body: { module?: string; fn?: string } }>("/api/descriptions", async (request, reply) => {
    if (!request.body?.module || !request.body?.fn) return reply.code(400).send({ error: "module and fn are required" });
    try { return withoutSource(await generateDescription(db, projectRoot, request.body.module, request.body.fn)); }
    catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/ws", { websocket: true }, (socket) => { clients.add(socket); socket.on("close", () => clients.delete(socket)); });
  app.get("/", async (_request, reply) => reply.sendFile("index.html"));

  const poll = setInterval(() => {
    try {
      const rows = db.prepare("SELECT rowid, trace_id, span_id, parent_id, module, fn, t0, t1, args, result, error FROM events WHERE rowid > ? ORDER BY rowid").all(lastRow) as EventRow[];
      if (!rows.length) return;
      lastRow = rows.at(-1)!.rowid;
      const payload = JSON.stringify({ type: "events", events: rows.map(asEvent) });
      for (const client of clients) if (client.readyState === client.OPEN) client.send(payload);
    } catch { /* A busy writer must never take down the inspector. */ }
  }, 150);
  app.addHook("onClose", async () => { clearInterval(poll); db.close(); });
  await app.listen({ host: "127.0.0.1", port });
  return app;
}
