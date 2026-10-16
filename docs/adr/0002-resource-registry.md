# 0002 — A declarative resource registry

- Status: accepted

## Context

Each Omie endpoint has its own method names, paging fields, filter names and record shapes.
Spreading that knowledge through the planner, executor, inspector and UI would make it hard to
review what the server is allowed to call.

## Decision

One registry (`packages/sql-engine/src/registry/resources.ts`) declares every virtual table: the
endpoint and calls, columns and their JSON paths, which predicates can be pushed down and how,
and which write operations exist. It is validated at startup.

## Consequences

- The registry is the **allowlist**: the engine and the API inspector can only call what it
  declares. No user input ever becomes a URL.
- `SHOW TABLES`, `DESCRIBE`, the schema tree, autocompletion, the AI prompt and the resource
  documentation are all derived from it.
- Unsupported operations fail early and uniformly (`OPERATION_NOT_SUPPORTED`).
- Payloads that could not be verified against a live account are marked UNCONFIRMED in the
  registry notes instead of being presented as certain.
