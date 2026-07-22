---
name: atlas-debug
description: Reproduce, investigate, fix, and verify local TypeScript web application behavior by driving the real app in a browser, correlating each interaction with System Atlas traces in .atlas/atlas.db, and inspecting the exact underlying source, callers, dependencies, configuration, and tests. Use for browser-visible failures, unexpected or repeated calls, slow functions, runtime versus static graph differences, specific Atlas traces, and evidence-backed post-fix verification.
---

# Atlas Debug

Triangulate three independent evidence surfaces: what the browser shows, what Atlas observed at runtime, and what the repository code actually does. Do not diagnose from only one surface when the other two are available.

## Browser-trace-code loop

1. Confirm the target project root, app URL, active server, and database path. Ensure they belong to the same running project before editing.
2. Use the available browser-control skill to inspect the existing page, URL, visible state, and browser errors. Preserve the user's current route and port.
3. Mark the reproduction start with `node -p 'Date.now()'`. Drive the smallest realistic user flow in the browser; do not substitute `curl` for UI behavior.
4. Record the exact action, before/after visible state, URL changes, and relevant console or failed-request evidence exposed by the browser tooling.
5. Query `atlas diagnose --since <timestamp>` and select the trace whose time and root span match that browser action.
6. Run `atlas diagnose trace <trace-id> --include-source`. Add `--include-values` only when arguments or results are necessary.
7. Read every returned source definition that matters, then expand into the complete file, direct callers and callees, imported types, configuration, schemas, and relevant tests. Search the repository rather than inferring missing code.
8. Form a hypothesis that accounts for browser evidence, span order and timings, captured errors or values, and the implementation. State any mismatch between those surfaces.
9. Diagnose only when the user asked for diagnosis. When authorized to fix, make the smallest change that explains all observed evidence.
10. Mark a fresh timestamp, repeat the same browser flow, inspect the resulting trace, and run `diagnose verify` for expected functions. Confirm the browser result, browser errors, runtime errors, call counts, and timings.

Read [references/browser-code-loop.md](references/browser-code-loop.md) before debugging a browser application. Read [references/diagnose-command.md](references/diagnose-command.md) for command modes and flags.

## Source investigation

- Treat `--include-source` as the entry point, not the entire investigation. A traced exported function may delegate the actual bug to untraced internal code.
- Open the reported absolute file at its exact line and verify the source hash still represents the current definition.
- Follow runtime parents and children first, then static imports and repository searches.
- Inspect relevant tests and the current git diff before changing code. Preserve unrelated user work.
- Use descriptions only as orientation. Prefer source, types, tests, and runtime evidence for conclusions.

## Interpretation rules

- Say "not observed in this database and selection," never "did not happen," when a span is absent.
- Check instrumentation coverage before treating absence as evidence. Atlas observes exported functions and class methods, not console logs or every internal call.
- Treat a rogue edge as a runtime call missing from the static graph, not automatically as a bug.
- Treat a ghost edge as statically possible but unobserved in the selection, not as a failed call.
- Prefer one browser action and one trace over a broad retention window.
- Never clear traces, update tables, change SQLite pragmas, or otherwise mutate the database.
- Treat captured values and returned source as sensitive local evidence. Summarize only what is needed in the final answer.
- Do not claim browser verification from an HTTP status, build, or trace alone. Inspect the rendered result through the browser.

## Command discovery

Prefer the target project's installed binary without downloading anything:

1. Use an existing package-manager script that wraps Atlas.
2. Otherwise use `pnpm exec atlas`, `npm exec atlas`, or `./node_modules/.bin/atlas`.
3. In the System Atlas repository, build first and use `node packages/server/dist/cli.js diagnose`.

Do not install or upgrade packages merely to run diagnostics without user approval. Do not silently replace unavailable browser control with a weaker verification method; report the limitation.

## Completion

Finish with a compact evidence chain: browser reproduction, correlated trace IDs, decisive functions and source locations, root cause, post-fix browser result, post-fix trace and verification result, and any remaining instrumentation boundary.
