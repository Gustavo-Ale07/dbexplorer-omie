# Deployment

The supported deployment is Docker Compose on a Linux host: one `app` container (API + web UI)
and one `db` container (PostgreSQL 17), behind a reverse proxy that terminates HTTPS.

## Requirements

- Docker Engine 24+ with the Compose plugin.
- A DNS name pointing at the host and a reverse proxy (Caddy or Nginx examples below).
- Omie API credentials (`app_key` / `app_secret`) for live mode. Mock mode needs none.

## Install

```bash
git clone https://github.com/Gustavo-Ale07/dbexplorer-omie.git
cd dbexplorer-omie
cp .env.example .env
nano .env
docker compose up -d --build
```

Edit at least these values in `.env` — the app refuses to start in production while they hold
the placeholders:

| Variable                   | What to set                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `APP_URL`                  | the public HTTPS URL, e.g. `https://sql.example.com`                 |
| `POSTGRES_PASSWORD`        | a long random password (URL-safe characters: `openssl rand -hex 24`) |
| `SESSION_SECRET`           | `openssl rand -base64 48`                                            |
| `BOOTSTRAP_ADMIN_EMAIL`    | the first administrator's e-mail                                     |
| `BOOTSTRAP_ADMIN_PASSWORD` | a temporary strong password; you must change it on first login       |

Then check:

```bash
docker compose ps                     # both services "healthy"
docker compose logs -f app            # "Omie SQL Explorer API started"
curl -fsS http://127.0.0.1:3001/health/ready
```

The app listens on `127.0.0.1:3001` on the host (`APP_BIND` / `APP_PORT`). PostgreSQL has no
published port; it is reachable only from the `app` container on an internal network.

## Connecting to Omie

1. Start in `OMIE_MODE=mock` to validate the installation with fictitious data.
2. Set `OMIE_MODE=live`, `OMIE_APP_KEY` and `OMIE_APP_SECRET`, then `docker compose up -d`.
3. Open **Status** in the UI (administrators): it runs a lightweight read call and shows whether
   the credentials work.

Keep `OMIE_READ_ONLY=true` until you have tested the write payloads you need on a sandbox Omie
account. To allow writes, set `OMIE_READ_ONLY=false` and enable only the operations you need
(`OMIE_ALLOW_UPDATE=true`, …). Every write still requires preview and confirmation.

## Reverse proxy

### Caddy (automatic HTTPS)

```caddyfile
sql.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3001
}
```

### Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name sql.example.com;

  ssl_certificate     /etc/letsencrypt/live/sql.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sql.example.com/privkey.pem;

  client_max_body_size 1m;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Long Omie scans: keep above OMIE_QUERY_TIMEOUT_MS.
    proxy_read_timeout 180s;
  }
}

server {
  listen 80;
  server_name sql.example.com;
  return 301 https://$host$request_uri;
}
```

### TRUST_PROXY

The app uses the client IP for rate limits, login lockout records and the audit log. Behind a
proxy, set `TRUST_PROXY` so it reads `X-Forwarded-For` correctly:

- `TRUST_PROXY=1` — one proxy in front (the usual Caddy/Nginx setup).
- `TRUST_PROXY=10.0.0.10,10.0.0.11` — trust only these proxy addresses.
- `TRUST_PROXY=false` — the app is exposed directly; forwarded headers are ignored.

Never set `TRUST_PROXY=true` when clients can reach the app without going through the proxy:
they could spoof their IP and dodge rate limits.

`APP_URL` must match the origin users type in the browser. It is used for the CSRF origin check;
a mismatch shows up as `CSRF_REJECTED`.

## Backup and restore

All application state (users, history, saved queries, audit log) lives in PostgreSQL. Omie data
is never stored, so there is nothing else to back up.

```bash
# Backup (compressed custom format)
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > backup-$(date +%F).dump

# Restore into the running database (replaces existing objects)
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < backup-2026-01-31.dump
docker compose restart app
```

Schedule the backup with cron or a systemd timer, keep copies off the host and test a restore
regularly. The dump contains password hashes and the audit log: store it encrypted.

## Upgrades

```bash
git pull
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
```

Database migrations are versioned and applied automatically when the app starts. Take a backup
before upgrading.

## Operations

| Task                 | Command / where                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Logs                 | `docker compose logs -f app` (JSON lines; ship them to your log stack)                   |
| Liveness / readiness | `GET /health/live`, `GET /health/ready` (database + registry)                            |
| Version and commit   | footer of the UI, `GET /api/meta`; the commit comes from the `GIT_COMMIT` build argument |
| Lost admin password  | another admin resets it in **Usuários**; see [troubleshooting](troubleshooting.md)       |
| Stop                 | `docker compose down` (data stays in the `db-data` volume)                               |
| Remove everything    | `docker compose down -v` — **deletes the database volume**                               |

## Hardening checklist

- [ ] HTTPS only, HSTS enabled by the app; HTTP redirects to HTTPS at the proxy.
- [ ] `APP_BIND=127.0.0.1` (default) so the app is reachable only through the proxy.
- [ ] Strong, unique `SESSION_SECRET` and `POSTGRES_PASSWORD`; `.env` readable only by root
      (`chmod 600 .env`).
- [ ] `OMIE_READ_ONLY=true` unless writes are needed; enable only the required `OMIE_ALLOW_*`.
- [ ] Users have the least role they need (`VIEWER` by default).
- [ ] `AI_PROVIDER=disabled`, or `AI_SHARE_RESULT_DATA=false` if the assistant is enabled.
- [ ] Backups scheduled and restore tested.
- [ ] Host firewall allows only 80/443 (and SSH).
