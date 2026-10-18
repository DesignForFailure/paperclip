---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

Paperclip uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.paperclip/instances/default/db/` for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.paperclip/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

### A password of the instance's own (optional)

By default the embedded cluster's role `paperclip` has the password `paperclip`, so any local process that reaches its loopback port (54329 by default) can open the database. Set `PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE` to an absolute path to give it a password of its own:

- **The file:** the server makes it when it is absent and the cluster was never given a password from a file: a random password, mode 0600, in a folder made 0700. A file others can read, or an empty one, is refused. A command that does not start the cluster (`db:backup`, the maintenance scripts) never makes it.
- **A new cluster** is initialised with the fixed password, which is then all that initdb's temporary file (`$TMPDIR/pg-password-*`, readable by other users) holds, and is given the file's password as below before it first listens on TCP.
- **A new cluster, or one made before the file,** is given the password once, when the server (or `pnpm db:migrate`, or a CLI command that starts the cluster) next starts it. First it starts the cluster with no TCP listener and its socket in a new private folder (under `/tmp` when `TMPDIR` is too long for a socket path), so no other process can use the fixed password meanwhile. It changes the role's password there, stops the cluster, and then starts it as usual. From then on `paperclip` no longer opens it. A digest of the password, `paperclip-role-password.sha256` in the data directory, records that this is done.
- **A cluster that is already running** with the fixed password is never changed over TCP: the server refuses to use it. Stop it and start the server again.
- **The same setting is needed** wherever a command opens that database: the CLI's `db:backup`, `routines`, `auth bootstrap-ceo` and `worktree` commands, and the maintenance scripts. Every one reads the variable, or the instance's `.env`.
- **Worktrees:** `paperclipai worktree init` from an instance that uses a password file gives the worktree a file of its own in the worktree's `secrets/` folder, recorded in its `.env`.
- **Keep the file:** it holds the only copy of the password. If it's removed after the cluster was given its password, the server makes no new one: it stops and asks for the file to be put back.
- **A start stopped during that private step** (killed) leaves the cluster running with no TCP listener. The next start names it and its pid: stop it (`kill -INT <pid>`) and start again.
- **Backups and restores** give `pg_dump` and `psql` the password in `PGPASSWORD`, never on their command line.

Unset, nothing changes.

### Server settings for the embedded cluster (optional)

The embedded cluster runs with PostgreSQL's defaults (128 MB of shared buffers, 100 connections, 4 MB of `work_mem`). A small host can size it down with `PAPERCLIP_EMBEDDED_POSTGRES_FLAGS`, whitespace-separated `key=value` pairs:

```sh
PAPERCLIP_EMBEDDED_POSTGRES_FLAGS="shared_buffers=64MB max_connections=20 work_mem=2MB max_parallel_workers=2"
DATABASE_POOL_MAX=4
```

- **Each pair** is given to `postgres` as `-c key=value` every time the server (or `pnpm db:migrate`) starts the cluster, including the server's restarts after an unexpected exit. Nothing is written to `postgresql.conf`, and initdb is not given them, so removing the variable puts the defaults back at the next start.
- **Refused** at startup, before any cluster starts, with an error naming the pair: anything that is not `key=value` with a value (so a value cannot hold whitespace, and `-c` is not written), and the settings Paperclip decides for the cluster: `port`, `listen_addresses`, `unix_socket_directories`, `data_directory`, `config_file`, `hba_file`, `ident_file`. PostgreSQL checks the names and values when the cluster starts; a wrong one stops the start with its message in the startup log.
- **`max_connections`** must cover the server's pool (`DATABASE_POOL_MAX`, 10 by default) plus the one-connection clients it opens beside it (startup checks and migrations, and two during a backup), and anything else you connect.
- **A cluster already running** when the server starts is reused as it is: its settings change at its next start by the server.
- The CLI's own cluster starts (`worktree`, `routines`, `auth bootstrap-ceo`) do not read it.

Unset or empty, nothing changes.

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Set the connection string:

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Push the schema:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

If using connection pooling (transaction mode), disable prepared statements via the environment — no source edits needed:

```sh
DATABASE_PREPARED_STATEMENTS=false
```

Related optional client tuning: `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_SECONDS`, `DATABASE_CONNECT_TIMEOUT_SECONDS`, `DATABASE_MAX_LIFETIME_SECONDS`, `DATABASE_APPLICATION_NAME`. Driver defaults apply when unset, except that idle pooled connections close after 60 seconds (`DATABASE_IDLE_TIMEOUT_SECONDS=0` keeps them open) and the pool reports `application_name=paperclip`. See [Connection pool settings](#connection-pool-settings).

## Connection Pool Settings

The server opens one postgres.js pool for its own queries (and a second one when `DATABASE_MIGRATION_URL` points at a different connection). Every setting is optional:

| Variable | Default | Effect |
|----------|---------|--------|
| `DATABASE_POOL_MAX` | `10` (driver) | Maximum pooled connections. |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `60` | Close a pooled connection after this much idle time. `0` keeps idle connections open forever (the driver default). |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `30` (driver) | Give up on a connection attempt after this long. |
| `DATABASE_MAX_LIFETIME_SECONDS` | 30–60 min, randomized (driver) | Recycle a pooled connection once it is this old. |
| `DATABASE_APPLICATION_NAME` | `paperclip` | Value of `application_name` in `pg_stat_activity`, so you can find Paperclip's backends: `SELECT * FROM pg_stat_activity WHERE application_name = 'paperclip';` |
| `DATABASE_PREPARED_STATEMENTS` | `true` (driver) | Set `false` behind a transaction-mode pooler (see above). |

The server ends its pools during shutdown (SIGINT/SIGTERM) and when startup fails after the pool was opened, so a restarting server does not leave idle backends behind. Size `max_connections` on the PostgreSQL side for at least `DATABASE_POOL_MAX` per server process plus your other clients.

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.
