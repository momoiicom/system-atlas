# Atlas diagnose command

All modes print JSON to stdout. Pass `--project <root>` to select the target project or `--db <path>` to override its configured database. Database access is read-only.

## Modes

```sh
atlas diagnose overview --project <root> --since 10m
atlas diagnose trace <trace-id> --project <root> --include-source
atlas diagnose function --project <root> --module <module> [--fn <function>] --since 1h --include-source
atlas diagnose verify --project <root> --since <reproduction-start> --expect '<module>#<function>'
```

`overview` is the default mode. It returns trace and span counts, error groups, recent errors, call hotspots, slow functions, and rogue or ghost graph edges.

`trace` returns every span in one trace with parent depth. It ignores the time window when loading the selected trace.

`function` requires `--module` and optionally narrows with `--fn`.

`verify` passes only when the window contains at least one span, every repeated `--expect` value was observed, and the selected evidence has no errors. Add `--allow-errors` only when errors are an intentional part of the behavior being verified. A failed verification exits with status `2` and still prints the report.

## Shared flags

- `--since <time>`: Relative duration such as `10m` or `2h`, ISO timestamp, Unix seconds, or Unix milliseconds. Defaults to 15 minutes.
- `--until <time>`: Use the same formats to cap the window.
- `--limit <1-100>`: Bound each returned evidence list. Defaults to 20.
- `--module <path>` and `--fn <name>`: Use exact matches.
- `--trace <id>`: Select a trace explicitly.
- `--include-values`: Decode stored arguments and results. Omit by default.
- `--include-source`: Return the exact source definition, file, line, column, and source hash for observed functions. Use after narrowing to a trace or function.
- `--expect '<module>#<function>'`: Repeat for every function that must be observed during verification.

The report includes `projectRoot` and `database`. Confirm both before drawing conclusions.
