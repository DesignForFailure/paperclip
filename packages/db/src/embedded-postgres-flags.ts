/**
 * Server settings for the embedded PostgreSQL cluster from `PAPERCLIP_EMBEDDED_POSTGRES_FLAGS` (a fork setting, for
 * Continuum, which sizes the cluster for one person). The value is whitespace-separated `key=value` pairs, for example
 * `shared_buffers=64MB max_connections=20`; each becomes `-c key=value` on the `postgres` command line, so it applies at
 * every start of the cluster (initdb is not given them) and is never written to `postgresql.conf`. Unset or empty, the
 * cluster runs with PostgreSQL's defaults, as upstream does.
 *
 * Refused, with an error naming the variable and the pair: anything that is not `key=value` with a non-empty value (so
 * a value cannot hold whitespace), and the settings Paperclip itself decides for the cluster (where it listens, its
 * files). PostgreSQL checks the names and values themselves when the cluster starts.
 */
export const EMBEDDED_POSTGRES_FLAGS_ENV = "PAPERCLIP_EMBEDDED_POSTGRES_FLAGS";

/** Settings Paperclip sets or relies on for the embedded cluster: given here they would change where it listens or reads its files. */
const PAPERCLIP_MANAGED_SETTINGS = new Set([
  "port",
  "listen_addresses",
  "unix_socket_directories",
  "data_directory",
  "config_file",
  "hba_file",
  "ident_file",
]);

const PAIR = /^([A-Za-z_][A-Za-z0-9_.]*)=(\S+)$/;

/** The `postgres` arguments (`-c key=value` per pair) that `PAPERCLIP_EMBEDDED_POSTGRES_FLAGS` asks for; `[]` when unset. */
export function embeddedPostgresFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[EMBEDDED_POSTGRES_FLAGS_ENV]?.trim() ?? "";
  if (raw === "") return [];
  const flags: string[] = [];
  for (const pair of raw.split(/\s+/)) {
    const match = PAIR.exec(pair);
    if (!match) {
      throw new Error(
        `${EMBEDDED_POSTGRES_FLAGS_ENV}: "${pair}" is not a key=value setting; give whitespace-separated key=value pairs ` +
          "without -c, for example: shared_buffers=64MB max_connections=20",
      );
    }
    const key = match[1]!.toLowerCase();
    if (PAPERCLIP_MANAGED_SETTINGS.has(key)) {
      throw new Error(
        `${EMBEDDED_POSTGRES_FLAGS_ENV}: "${match[1]}" is decided by Paperclip for the embedded cluster and cannot be set here`,
      );
    }
    flags.push("-c", `${match[1]}=${match[2]}`);
  }
  return flags;
}
