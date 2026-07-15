import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve, relative } from "node:path";
import { isPromise } from "node:util/types";
import Database from "better-sqlite3";
import type { AtlasConfig, AtlasEvent } from "./types.js";
import { atlasConfig } from "./config.js";

type Context = { traceId: string; spanId: string };
type Meta = { module: string; fn: string };

function httpSummary(value: unknown): unknown {
  if (value instanceof IncomingMessage) {
    const request = value as IncomingMessage & { originalUrl?: unknown; params?: unknown; query?: unknown; body?: unknown };
    return {
      $type: "Request",
      method: request.method,
      url: typeof request.originalUrl === "string" ? request.originalUrl : request.url,
      params: request.params,
      query: request.query,
      body: request.body,
    };
  }
  if (value instanceof ServerResponse) {
    return { $type: "Response", statusCode: value.statusCode, headersSent: value.headersSent };
  }
  return undefined;
}

function shape(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "object") {
    const summary = httpSummary(value);
    if (summary) return shape(summary, seen);
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) result[key] = shape(child, seen);
    return result;
  }
  return typeof value;
}

export function stringify(value: unknown, cfg: AtlasConfig): string | null {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(cfg.capture === "shapes" ? shape(value) : value, function (key, child) {
      if (cfg.redact.some((pattern) => pattern.test(key))) return "[redacted]";
      if (typeof child === "bigint") return `${child}n`;
      if (typeof child === "function") return "[Function]";
      if (child && typeof child === "object") {
        const summary = httpSummary(child);
        if (summary) return summary;
        if (seen.has(child)) return "[Circular]";
        seen.add(child);
        const plain = Object.getPrototypeOf(child) === Object.prototype || Array.isArray(child);
        if (!plain) return { $type: child.constructor?.name || "Object", ...child };
      }
      return child;
    });
    if (json === undefined) return null;
    const bytes = Buffer.byteLength(json);
    if (bytes <= 4096) return json;
    return `${json.slice(0, 4000)}…[truncated, ${bytes} bytes total]`;
  } catch (error) {
    return `"[unserializable: ${error instanceof Error ? error.message : "unknown"}]"`;
  }
}

class Emitter {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;
  private readonly batch: AtlasEvent[] = [];
  private readonly cfg = { ...atlasConfig(), capture: process.env.ATLAS_CAPTURE === "shapes" ? "shapes" as const : atlasConfig().capture, dbPath: process.env.ATLAS_DB_PATH || atlasConfig().dbPath, retentionHours: Number(process.env.ATLAS_RETENTION_HOURS || atlasConfig().retentionHours) };
  private timer: NodeJS.Timeout | undefined;
  private warned = false;

  constructor() {
    const file = resolve(process.cwd(), this.cfg.dbPath);
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        rowid INTEGER PRIMARY KEY, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_id TEXT,
        module TEXT NOT NULL, fn TEXT NOT NULL, t0 INTEGER NOT NULL, t1 INTEGER NOT NULL,
        args TEXT, result TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_events_module ON events(module);
      CREATE TABLE IF NOT EXISTS static_graph (from_module TEXT NOT NULL, to_module TEXT NOT NULL, captured_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS descriptions (module TEXT NOT NULL, fn TEXT NOT NULL, source_hash TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(module, fn, source_hash));
    `);
    this.db.prepare("DELETE FROM events WHERE t0 < ?").run(Date.now() - this.cfg.retentionHours * 3_600_000);
    this.insert = this.db.prepare("INSERT INTO events (trace_id, span_id, parent_id, module, fn, t0, t1, args, result, error) VALUES (@traceId, @spanId, @parentId, @module, @fn, @t0, @t1, @args, @result, @error)");
    process.once("beforeExit", () => this.flush());
    process.once("SIGINT", () => this.flush());
  }

  emit(event: AtlasEvent) {
    this.batch.push(event);
    if (this.batch.length >= 500) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 50).unref();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.batch.length) return;
    const events = this.batch.splice(0);
    try {
      this.db.transaction((rows: AtlasEvent[]) => rows.forEach((row) => this.insert.run(row)))(events);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`[atlas] SQLite write failed; dropping instrumentation events: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  capture(value: unknown) { return stringify(value, this.cfg); }
}

class Runtime {
  private readonly storage = new AsyncLocalStorage<Context>();
  private readonly emitter = new Emitter();

  wrap<T extends Function>(fn: T, meta: Meta): T {
    Object.defineProperty(fn, "name", { value: meta.fn, configurable: true });
    return new Proxy(fn, { apply: (target, thisArg, args) => this.call(meta, thisArg, args, () => Reflect.apply(target, thisArg, args)) }) as T;
  }

  call<T>(meta: Meta, thisArg: unknown, args: ArrayLike<unknown>, invoke: () => T): T {
    const active = this.storage.getStore();
    const header = !active ? Array.from(args).find((value): value is { headers?: Record<string, unknown> } => !!value && typeof value === "object" && "headers" in value)?.headers?.traceparent : undefined;
    const adoptedTrace = typeof header === "string" ? /^[0-9]{2}-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/i.exec(header)?.[1] : undefined;
    const context = { traceId: active?.traceId ?? adoptedTrace ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") };
    const t0 = Date.now();
    const finish = (result: unknown, thrown?: unknown) => {
      const error = thrown instanceof Error ? `${thrown.message}\n${thrown.stack?.split("\n").slice(0, 5).join("\n") || ""}` : thrown ? String(thrown) : null;
      this.emitter.emit({ traceId: context.traceId, spanId: context.spanId, parentId: active?.spanId ?? null, module: meta.module, fn: meta.fn, t0, t1: Date.now(), args: this.emitter.capture(Array.from(args)), result: thrown ? null : this.emitter.capture(result), error });
    };
    return this.storage.run(context, () => {
      try {
        const value = invoke();
        // Some synchronous library objects (Fastify instances, for example) are
        // thenable. Treating every thenable as a promise changes the function's
        // return value and can break the host application.
        if (isPromise(value)) {
          return Promise.resolve(value).then((result) => { finish(result); return result; }, (error) => { finish(undefined, error); throw error; }) as T;
        }
        finish(value);
        return value;
      } catch (error) {
        finish(undefined, error);
        throw error;
      }
    });
  }
}

let singleton: Runtime | undefined;
export function getAtlasRuntime() { return singleton ??= new Runtime(); }
export function projectRelative(file: string) { return relative(process.cwd(), file).replaceAll("\\", "/"); }
