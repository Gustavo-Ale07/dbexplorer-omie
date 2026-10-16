# 0004 — No transactions and no write retries

- Status: accepted

## Context

Omie has no transactions, no batch atomicity and no idempotency keys. A call that timed out may
or may not have been applied.

## Decision

- `BEGIN`, `COMMIT`, `ROLLBACK` and `SAVEPOINT` are rejected with an explanation. The product
  never claims atomicity or rollback.
- Writes run one call per record, in order. The run stops at the first failure.
- Write calls are **never retried automatically**. Read calls are retried with jittered backoff
  on transient errors only.

## Consequences

- A multi-record write can end `partial`. The outcome and the audit log list which records were
  changed, which failed and which were not attempted, so the user can decide what to do next.
- Blind retries cannot create duplicate records or apply an update twice.
