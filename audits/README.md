# Fredo Audits

This folder collects audits of Fredo — performance, architecture, security, reliability, and process/pipeline health. Each audit is a self-contained Markdown report: headline metrics and root causes up top, detailed evidence and a fix table below.

## Adding an audit

- One file per audit; use `<topic>_audit.md` (add a date suffix if the topic recurs).
- Ground every claim in a source (event store, code, docs) — no estimates without a stated method.
- Keep a short "Measurement definitions" section so numbers are reproducible.
- Add a row to the index below.

## Index

| Audit | Scope | Date |
|---|---|---|
| [Pipeline Performance Audit](./performance_audit.md) | Agentic pipeline cycle time, rework, tooling, and guardrail health | 2026-11-23 |
