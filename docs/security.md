# Security

This document describes the threat model and the controls in place. Report vulnerabilities as
described in [SECURITY.md](../SECURITY.md).

## Threat model

| Asset                                  | Main threats                                                          |
| -------------------------------------- | --------------------------------------------------------------------- |
| `OMIE_APP_KEY` / `OMIE_APP_SECRET`     | leaking to the browser, logs, audit records, error messages, the repo |
| Omie data (customers, orders, finance) | unauthorized reads, over-fetching, exfiltration through the AI        |
| Omie records (writes)                  | accidental or malicious bulk changes, replayed confirmations          |
| User accounts and sessions             | brute force, session theft or fixation, CSRF, privilege escalation    |
| The server itself                      | SSRF through configurable URLs, injection, resource exhaustion        |

The application is meant for a small team behind HTTPS. It is **not** designed to be exposed to
anonymous users.

## Credentials

- Omie credentials are read from the environment by the server only and attached to each Omie
  request by `packages/omie-client`. The web bundle never receives them; there is no endpoint that
  returns them.
- Every structure that leaves the Omie client (inspector entries, the API Request tab, history,
  audit, logs, errors) goes through `packages/shared/src/redact.ts`, which replaces values of
  sensitive keys (`app_key`, `app_secret`, `authorization`, `cookie`, `*token`, `*secret`,
  `*password`, `*apikey`) with `***REDACTED***` and also scrubs the literal configured secret
  values from any string.
- Configuration is validated with a schema at boot. In production the server **refuses to
  start** when `SESSION_SECRET` is short or a placeholder, when the bootstrap password is the
  placeholder or weak, when `DATABASE_URL` still contains the placeholder password or points to
  the in-memory database, when `APP_URL` is not HTTPS, when `LOG_LEVEL` is `debug`/`trace`, or
  when `OMIE_MODE=live` lacks credentials. Problems are listed by name; secret values are never
  printed.
- `OMIE_BASE_URL` must be `https://app.omie.com.br/…` in production, and AI provider base URLs
  are fixed per provider, so configuration cannot be turned into an SSRF primitive.

## Authentication and sessions

- Passwords are hashed with Argon2id (`@node-rs/argon2`). Policy: at least 12 characters and three
  of upper case, lower case, digits and symbols. The bootstrap administrator must change the
  password on first login (`PASSWORD_CHANGE_REQUIRED` until then).
- Login failures are counted per account; after `LOGIN_MAX_ATTEMPTS` the account is locked for
  `LOGIN_LOCK_MINUTES`. A locked account gets the same `INVALID_CREDENTIALS` answer as a wrong
  password, so lockouts do not reveal which e-mails exist; the lock is recorded in the audit log. Login and password change are also rate-limited per IP.
  Unknown e-mails and wrong passwords return the same error, and the password hash is verified
  against a dummy hash for unknown users to keep timing similar.
- Session tokens are 256-bit random values. Only their SHA-256 hash is stored. A new token is
  issued at login and after a password change (all other sessions of the user are revoked), so a
  pre-set cookie cannot be fixed onto a session.
- In production the cookie is `__Host-dbx_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, with an
  absolute expiry (`SESSION_HOURS`). Deactivating a user or changing their role revokes their
  sessions.

## Authorization

| Role       | Can                                                              |
| ---------- | ---------------------------------------------------------------- |
| `VIEWER`   | `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, own history and queries |
| `OPERATOR` | everything above plus `INSERT` and `UPDATE`                      |
| `ADMIN`    | everything above plus `DELETE`, users, audit log, system status  |

Role checks happen on the server for every request. History, saved queries, running executions
and write previews are always scoped by the owner's user id (no IDOR through ids in the URL);
administrators see the audit log of all users.

## Write protection

Global flags take precedence over roles:

- `OMIE_READ_ONLY=true` (default) rejects every write with `READ_ONLY_MODE`.
- `OMIE_ALLOW_INSERT`, `OMIE_ALLOW_UPDATE`, `OMIE_ALLOW_DELETE` (all `false` by default) enable
  each operation separately.
- Operations the Omie API does not offer for a resource answer `OPERATION_NOT_SUPPORTED`.

When a write is allowed, it still follows a fixed flow:

1. **Plan** — `UPDATE`/`DELETE` require `WHERE`. The server reads the matching records from Omie
   and refuses more than `OMIE_MAX_WRITE_ROWS` targets.
2. **Preview** — the user sees every target with before/after values, the Omie calls that will be
   made, the risk and a reminder that Omie has no transactions.
3. **Confirmation token** — the preview carries a token
   `<previewId>.<HMAC(previewId | user | session | statement hash)>`, valid for
   `WRITE_CONFIRMATION_TTL_SECONDS`. The server row is consumed atomically, so a token works once
   (`CONFIRMATION_USED`), only for the same user, session and exact statement
   (`CONFIRMATION_INVALID`), and only before it expires (`CONFIRMATION_EXPIRED`).
4. **Revalidation** — flags and role are checked again, the targets are re-read and their hash is
   compared with the preview. If anything changed, the write is refused (`TARGETS_CHANGED`) and
   must be previewed again.
5. **Execution** — one Omie call per record, sequentially, **never retried**. The run stops at the
   first failure; the outcome lists records changed, failed and not attempted.
6. **Audit** — the statement, targets, before/after values, per-record results, user, IP and
   request id are written to the audit log.

Read calls are retried with jittered backoff on transient errors. Write calls are never retried
automatically, because Omie offers no idempotency guarantee and a timeout does not mean the call
failed.

## Query safety

- SQL text is never concatenated into anything: it is parsed into an AST, validated against the
  registry, and translated into JSON parameters for allowlisted Omie calls. There is no database
  behind the virtual tables to inject into.
- Application data in PostgreSQL is accessed only through Drizzle's parameterized queries.
- Limits on rows, API calls, in-memory rows, JOIN fan-out, query time and SQL length
  (20,000 characters) bound the work any statement can cause. A user can cancel their own running
  query; an administrator can cancel any.
- The API inspector executes **only** read calls from the registry allowlist, chosen by id. The
  URL and method are never user-controlled. Parameters are validated as plain JSON objects
  (prototype-polluting keys such as `__proto__` are rejected).

## AI assistant

- Disabled by default (`AI_PROVIDER=disabled`). Providers: `mock`, `openai`, `anthropic`.
- It only **suggests** SQL. The suggestion is parsed and planned by the same engine (without
  calling Omie) and shown to the user, who decides whether to run it. Write suggestions go through
  the normal preview and confirmation flow.
- Only the schema (table and column names, types, relationships) is sent by default. Result rows
  are sent only when `AI_SHARE_RESULT_DATA=true`, and then they are wrapped as
  `<untrusted_data>`. The system prompt instructs the model to treat the user question and data
  as data, never instructions, and the delimiters are stripped from untrusted text so they cannot
  be forged.
- AI API keys stay on the server and are redacted like Omie credentials. Each generation is
  audited (`ai.generate`) without the provider key.

## HTTP hardening

- **CSRF** — state-changing requests must carry an `Origin` (or `Referer`) equal to `APP_URL`;
  bodies must be `application/json`, which rules out HTML form posts; cookies are
  `SameSite=Strict`.
- **CORS** — not enabled. The UI and API share one origin.
- **Headers** (`@fastify/helmet`) — strict CSP (`default-src 'self'`, no inline scripts,
  `frame-ancestors 'none'`, `object-src 'none'`), HSTS, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, frame denial. API responses with user data are
  `Cache-Control: no-store`.
- **XSS** — React escapes all output; the app never uses `dangerouslySetInnerHTML`. Monaco and its
  workers are served from our origin.
- **CSV export** — values starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed
  with `'` to prevent formula injection in spreadsheets.
- **Rate limits** — global per-IP limit plus stricter limits on login, password change, AI and the
  inspector. Behind a proxy set `TRUST_PROXY` so the client IP is correct.
- **Errors** — responses carry a stable `code`, a message and a `requestId`. Stack traces and
  internal details are only logged on the server.

## Logging and audit

Logs are structured (pino) and go to stdout. Request logs omit bodies, cookies and authorization
headers. The audit log stores: logins (success, and failures including lockouts), logouts, password changes,
user administration, write previews, denials, confirmations and outcomes, AI generations and
inspector calls. It never stores Omie credentials, session tokens, AI keys, passwords, cookies or
authorization headers.

## Supply chain

- Exact dependency versions, a committed lockfile and `pnpm install --frozen-lockfile` in CI and
  Docker. pnpm only runs install scripts for allowlisted packages.
- GitHub Actions are pinned to commit SHAs. CodeQL (`security-extended`), dependency review,
  gitleaks secret scanning and Dependabot run on the repository.
- The runtime image contains only production dependencies and runs as the unprivileged `node`
  user; compose drops all capabilities, sets `no-new-privileges` and mounts the root filesystem
  read-only.

## Known limitations

- Omie has no transactions. A failure in the middle of a multi-record write leaves the earlier
  records changed. The outcome report says exactly which ones.
- Revalidation narrows, but cannot remove, the window between the re-read and the write calls: a
  record could still be changed in Omie by someone else in between.
- Some write payloads are marked UNCONFIRMED in the registry (see
  [omie-resources.md](omie-resources.md)); test them against a sandbox account first.
- Rate limits and the login counter are kept per process. Run a single instance, or put a shared
  limiter in front of several.
