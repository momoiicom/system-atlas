import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { stringify } from "./runtime.js";
import type { AtlasConfig } from "./types.js";

const config: AtlasConfig = { include: ["**/*"], exclude: [], capture: "values", redact: [/token|secret|password|authorization|apikey/i], dbPath: ":memory:", retentionHours: 24 };

test("summarizes Node and Express HTTP arguments", () => {
  const request = Object.create(IncomingMessage.prototype) as IncomingMessage & { originalUrl: string; params: unknown; query: unknown; body: unknown };
  Object.assign(request, { method: "POST", url: "/invoice/demo", originalUrl: "/invoice/demo?preview=1", params: { customer: "demo" }, query: { preview: "1" }, body: { amount: 42, password: "hidden" } });
  const response = Object.create(ServerResponse.prototype) as ServerResponse;
  Object.defineProperties(response, { statusCode: { value: 201 }, headersSent: { value: true } });

  assert.deepEqual(JSON.parse(stringify([request, response], config)!), [
    { $type: "Request", method: "POST", url: "/invoice/demo?preview=1", params: { customer: "demo" }, query: { preview: "1" }, body: { amount: 42, password: "[redacted]" } },
    { $type: "Response", statusCode: 201, headersSent: true },
  ]);
});
