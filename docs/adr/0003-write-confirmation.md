# 0003 — Writes need a preview and a single-use confirmation

- Status: accepted

## Context

An `UPDATE` with a loose `WHERE` can change hundreds of records in an ERP, and Omie cannot undo
it. A SQL editor makes such mistakes easy.

## Decision

Writes are off by default (`OMIE_READ_ONLY=true`, each operation behind its own flag). When
enabled, every write follows: plan → preview (targets with before/after) → explicit
acknowledgement → single-use confirmation token bound to user, session and statement hash →
revalidation of flags, role and targets → sequential execution → audit.

`UPDATE` and `DELETE` require `WHERE`, and the number of targets is capped
(`OMIE_MAX_WRITE_ROWS`).

## Consequences

- No write can be triggered by a single request, a replayed request or a different user.
- If the records change between preview and confirmation, the write is refused
  (`TARGETS_CHANGED`) and must be reviewed again.
- Bulk changes beyond the cap need several reviewed statements, which is intentional.
