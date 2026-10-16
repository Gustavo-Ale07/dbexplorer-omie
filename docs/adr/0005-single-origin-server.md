# 0005 — One server process serves the API and the UI

- Status: accepted

## Context

Omie credentials grant full access to a company ERP account. A browser-side integration would
expose them to every user and to any XSS.

## Decision

The browser talks only to our server, which holds the credentials and calls Omie. The same
process serves the built UI, so the app has a single origin.

## Consequences

- `OMIE_APP_KEY` and `OMIE_APP_SECRET` never reach the browser; redaction covers every output
  path (responses, logs, history, audit).
- No CORS configuration is needed. CSRF protection is an origin check plus `SameSite=Strict`
  cookies and JSON-only bodies.
- Deployment is one container plus PostgreSQL. Horizontal scaling would need a shared rate
  limiter and is not a goal for now.
