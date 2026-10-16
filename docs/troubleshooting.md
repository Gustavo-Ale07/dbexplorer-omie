# Troubleshooting

Every error shown in the UI has a stable code (for example `READ_ONLY_MODE`) and a request id.
Search the server logs for the request id to find the details:

```bash
docker compose logs app | grep '<request id>'
```

## The app does not start

**`Invalid configuration:` followed by a list** — the environment failed validation. Each line
names the variable and the problem. Common ones:

| Message                                                             | Fix                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| `SESSION_SECRET is missing, a placeholder or too weak`              | `openssl rand -base64 48` and paste it into `.env`     |
| `BOOTSTRAP_ADMIN_PASSWORD is a placeholder or too weak`             | 12+ characters mixing upper, lower, digits and symbols |
| `DATABASE_URL still contains the placeholder database password`     | change `POSTGRES_PASSWORD` in `.env`                   |
| `APP_URL must use https:// in production`                           | use the public HTTPS URL served by your proxy          |
| `OMIE_APP_KEY and OMIE_APP_SECRET are required when OMIE_MODE=live` | fill both, or use `OMIE_MODE=mock`                     |
| `LOG_LEVEL debug/trace is not allowed in production`                | use `info`                                             |

**`set POSTGRES_PASSWORD in .env`** from `docker compose` — the variable is empty.

**Database connection refused / authentication failed** — `POSTGRES_PASSWORD` was changed after
the volume was created. PostgreSQL keeps the password it was initialized with. Either put the
old password back, or change it inside the database:

```bash
docker compose exec db psql -U dbexplorer -d dbexplorer -c "ALTER USER dbexplorer PASSWORD '<new>'"
```

Special characters such as `@`, `/`, `:` or `#` in `POSTGRES_PASSWORD` break the generated
`DATABASE_URL`. Use a hex or alphanumeric password.

## Login

| Symptom                                                | Cause and fix                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `CSRF_REJECTED` on login                               | `APP_URL` differs from the address in the browser (scheme, host or port).           |
| Login succeeds but you are sent back to the login page | The session cookie is `Secure`: open the app over HTTPS.                            |
| `ACCOUNT_LOCKED`                                       | Too many failures. Wait `LOGIN_LOCK_MINUTES` or ask an admin to reset the password. |
| `RATE_LIMITED`                                         | Too many requests from one IP. Behind a proxy, check `TRUST_PROXY`.                 |
| Bootstrap admin credentials are ignored                | The admin is created only when the database has no users. Change it in the UI.      |

**All administrators locked out.** Reset one password directly in the database. Generate an
Argon2id hash with the bundled library and update the row:

```bash
docker compose exec app node -e "import('@node-rs/argon2').then(a=>a.hash(process.argv[1]).then(console.log))" 'New-Strong#Pass2026'
docker compose exec db psql -U dbexplorer -d dbexplorer \
  -c "UPDATE users SET password_hash = '<hash>', must_change_password = true, failed_logins = 0, locked_until = NULL WHERE email = 'admin@example.com'"
```

## Queries

| Code                                      | Meaning and fix                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SQL_PARSE_ERROR`                         | Syntax error. The message points at the problem.                                                                       |
| `SQL_UNSUPPORTED`                         | The construct is outside the dialect; see [sql-dialect.md](sql-dialect.md).                                            |
| `RESOURCE_NOT_FOUND`                      | Unknown table. `SHOW TABLES` lists them; the message suggests the closest name.                                        |
| `COLUMN_NOT_FOUND`                        | Unknown column. `DESCRIBE <table>` lists them.                                                                         |
| `AMBIGUOUS_COLUMN`                        | The column exists in more than one joined table; qualify it (`c.codigo`).                                              |
| `SQL_UNSUPPORTED` on `tabela_preco_itens` | Add `WHERE codigo_tabela = …`; Omie cannot list items of every price table at once.                                    |
| `QUERY_ROW_LIMIT_EXCEEDED`                | `LIMIT` above `OMIE_MAX_ROWS`. Page with `LIMIT/OFFSET`.                                                               |
| `API_CALL_LIMIT_EXCEEDED`                 | The statement needs more than `OMIE_MAX_API_CALLS` Omie calls. Add filters that can be pushed to Omie (see `EXPLAIN`). |
| `QUERY_LIMIT_EXCEEDED`                    | Too many rows held in memory (large scans, GROUP BY over many rows). Filter more.                                      |
| `JOIN_CARDINALITY_LIMIT`                  | The join fans out too much. Filter one side first.                                                                     |
| `QUERY_TIMEOUT`                           | Ran longer than `OMIE_QUERY_TIMEOUT_MS`.                                                                               |

Use `EXPLAIN` before running a heavy query: it shows which filters go to Omie, which run locally
and how many calls to expect.

## Writes

| Code                                                      | Meaning                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `READ_ONLY_MODE`                                          | `OMIE_READ_ONLY=true` on the server.                                                 |
| `INSERT_DISABLED` / `UPDATE_DISABLED` / `DELETE_DISABLED` | The matching `OMIE_ALLOW_*` flag is `false`.                                         |
| `FORBIDDEN`                                               | Your role cannot run this statement (only `ADMIN` can `DELETE`).                     |
| `OPERATION_NOT_SUPPORTED`                                 | The Omie API does not offer this operation for the resource.                         |
| `WHERE_REQUIRED`                                          | `UPDATE` and `DELETE` need a `WHERE`.                                                |
| `WRITE_ROW_LIMIT_EXCEEDED`                                | More targets than `OMIE_MAX_WRITE_ROWS`. Narrow the `WHERE`.                         |
| `CONFIRMATION_EXPIRED`                                    | The preview is older than `WRITE_CONFIRMATION_TTL_SECONDS`. Run the statement again. |
| `CONFIRMATION_USED`                                       | The confirmation was already used. Run the statement again for a new preview.        |
| `TARGETS_CHANGED`                                         | The records changed in Omie after the preview. Review the new preview.               |

A write that stops halfway reports `partial`: the outcome and the audit log list which records
were changed, which failed and which were not attempted. Fix the cause and run a new statement
for the remaining records only.

## Omie errors

| Code                  | Meaning                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `OMIE_AUTH_ERROR`     | Omie rejected `app_key` / `app_secret`. Check the values and the app's permissions in Omie.                                             |
| `OMIE_RATE_LIMITED`   | Omie throttled the account. Reads are retried automatically; wait and try again.                                                        |
| `OMIE_BLOCKED`        | Omie temporarily blocked the account (usually after repeated identical calls or too many requests). Wait the time given in the message. |
| `OMIE_API_ERROR`      | Omie returned a business error (`faultstring` is shown, credentials redacted).                                                          |
| `OMIE_UNAVAILABLE`    | Network error or Omie 5xx.                                                                                                              |
| `OMIE_BAD_RESPONSE`   | The response did not have the expected shape. Please open an issue with the call name.                                                  |
| `OMIE_NOT_CONFIGURED` | `OMIE_MODE=live` without credentials.                                                                                                   |

The **API Inspector** page lets you run any allowlisted read call with your own parameters and
see the exact request (credentials redacted) and response. It is the quickest way to check what
Omie returns.

## AI assistant

- `AI_PROVIDER_DISABLED` — set `AI_PROVIDER` and the provider key in `.env`.
- `AI_PROVIDER_ERROR` — the provider failed or returned no SQL. Check the key, the model name and
  outbound network access from the container.
- The suggestion is marked with ✗ — the generated SQL failed validation. Edit it or rephrase the
  question; it is never executed automatically.
