# Browser and code evidence loop

Use this workflow for a local web application. Keep browser interaction and Atlas queries tightly bounded so one user action can be correlated with one trace.

## Establish the target

- Confirm the repository that owns the running process, the exact app URL, and the Atlas database reported by `diagnose`.
- Use the user's already-open browser when appropriate. Preserve its route, port, authentication state, and relevant form state.
- If the page is unreachable, inspect the active listener and app process before changing code.
- Do not inspect cookies, passwords, browser profiles, or session storage.

## Capture a reproduction

1. Inspect the rendered page and interactive controls before acting.
2. Note the start timestamp.
3. Perform one realistic interaction, including the clicks, typing, navigation, and submit behavior a user would perform.
4. Wait on observable page state or a specific request outcome instead of an arbitrary sleep.
5. Capture the resulting DOM or visible text. Take a screenshot when layout, animation, or visual state is part of the problem.
6. Read relevant console errors and failed requests when supported by the browser tooling.
7. Do not repeat the action until the first trace has been identified; repeated actions make correlation ambiguous.

## Correlate the trace

```sh
atlas diagnose --project <root> --since <start-ms>
atlas diagnose trace <trace-id> --project <root> --include-source
```

Choose the trace by timestamp, root function, duration, error, and expected child calls. If multiple traces remain plausible, reproduce once more in a fresh window instead of guessing.

Use `--include-values` only to answer a specific question. Avoid printing captured objects broadly.

## Expand the code context

For each decisive source entry:

- Open the complete file at the returned line.
- Inspect the function's callers and callees, including untraced internal helpers.
- Inspect imported types, validation schemas, environment/configuration reads, data-access boundaries, and error translation.
- Inspect nearby tests and search for other implementations of the same behavior.
- Inspect the current git diff so existing work is not mistaken for the bug or overwritten.
- Compare the runtime edge with the static graph, but treat both as evidence rather than intent.

## Verify the fix

1. Record a new timestamp after the fix is loaded.
2. Repeat the identical browser path.
3. Confirm the expected rendered state and absence of relevant browser errors.
4. Run verification with every function required by the fixed path:

```sh
atlas diagnose verify --project <root> --since <start-ms> \
  --expect '<module>#<function>'
```

5. Inspect the new trace with source when call order, call volume, values, or timing is part of the fix.
6. Compare before and after trace IDs, calls, errors, p50/p95 where meaningful, and visible browser output.

A passing verification proves only the declared runtime expectations. The browser result proves the user-visible behavior. Require both for a browser-facing fix.
