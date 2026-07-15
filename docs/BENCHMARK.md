# Instrumentation overhead benchmark

Run on 2026-07-13 with Node 24.18.0, the included Express demo, and 400 sequential local requests per run. Each mode was restarted before measurement; five runs were collected and the median is reported. The Atlas server was not running, which verifies the emitter's decoupling from inspection.

| Mode | Median for 400 requests | Median/request |
| --- | ---: | ---: |
| Baseline TypeScript demo | 656.827 ms | 1.642 ms |
| Demo with @system-atlas/register | 671.682 ms | 1.679 ms |

The measured median overhead is **2.26%**, below the v0.1 10% target.

## Reproduce

From `examples/express-demo`, start the baseline with `node --enable-source-maps --import tsx src/main.ts`. From a second terminal, send 400 sequential requests to `http://127.0.0.1:4310/invoice/bench` five times and record the median. Restart with `npm run demo:app` at the repository root and repeat the same request loop. Use the same Node version and machine for both modes.
