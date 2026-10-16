# 0001 — A virtual SQL layer over the Omie API

- Status: accepted

## Context

Omie exposes a JSON-RPC style REST API (`ListarClientes`, `ConsultarPedido`, …) with paging,
per-method filters and rate limits. There is no SQL access to the data. Teams still think in
tables and want to answer questions such as "orders of customers in SP this month" without
writing an integration each time.

Two options were considered:

1. **Sync** Omie into a local database and query it with real SQL.
2. **Translate** each SQL statement into Omie API calls at query time.

## Decision

Translate at query time. The explorer keeps no copy of Omie data.

## Consequences

- Results are always current; there is no sync job, no stored customer data and no drift.
- Query cost is measured in API calls. The planner pushes filters to Omie where the API allows,
  estimates calls and enforces explicit limits; `EXPLAIN` makes the cost visible.
- The dialect is a subset of SQL. Constructs that would hide unbounded API traffic (subqueries,
  UNION, CTEs) are rejected rather than emulated.
- Large analytical workloads remain out of scope; a sync-based tool suits them better.
