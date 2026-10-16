# Architecture decision records

| #                                    | Decision                                                     |
| ------------------------------------ | ------------------------------------------------------------ |
| [0001](0001-virtual-sql-layer.md)    | A virtual SQL layer over the Omie API, not a data copy       |
| [0002](0002-resource-registry.md)    | A declarative resource registry as the endpoint allowlist    |
| [0003](0003-write-confirmation.md)   | Writes need a preview and a single-use confirmation          |
| [0004](0004-no-transactions.md)      | No transactions and no write retries                         |
| [0005](0005-single-origin-server.md) | One server process serves API and UI; credentials stay there |
| [0006](0006-typescript-monorepo.md)  | TypeScript monorepo: Fastify, React, Drizzle, PostgreSQL     |
| [0007](0007-ai-suggests-only.md)     | The AI assistant only suggests SQL                           |
