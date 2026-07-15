# Product

## Register

product

## Users

One developer, working locally in a TypeScript codebase, needs to understand and debug behavior without modifying the target project's source files.

## Product Purpose

System Atlas turns module loading and exported-function calls into a local, inspectable execution map. Success is seeing an HTTP request propagate through a running system and inspecting its captured spans within a fraction of a second.

## Brand Personality

Forensic, calm, exact.

## Anti-references

Avoid generic SaaS dashboards, decorative analytics cards, force-directed spaghetti graphs, and noisy observability consoles that hide the trace under chrome.

## Design Principles

- Let the execution flow be the visual focus.
- Keep the system map spatially stable between sessions.
- Make evidence legible before adding analysis.
- Reveal detail progressively: module, function, span, value.
- Keep all controls close to the investigation they affect.

## Accessibility & Inclusion

The initial private build prioritizes dense desktop investigation. Semantic controls and readable contrast remain baseline expectations; expanded accessibility work can follow if it becomes open source.
