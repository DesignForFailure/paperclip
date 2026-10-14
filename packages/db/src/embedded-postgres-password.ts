import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

/**
 * The embedded PostgreSQL role's password.
 *
 * Upstream every embedded cluster's role `paperclip` has the fixed password `paperclip`, so any local process can
 * reach the database on its loopback port. With PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE set, the password is that
 * file's content instead: made once, random and readable by its owner alone, when the file is absent; a cluster made
 * before the file is given it once, the first time it is reached with the fixed password
 * (`adoptEmbeddedPostgresPassword`). Unset, nothing changes.
 */
export const EMBEDDED_POSTGRES_PASSWORD_FILE_ENV = "PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE";
export const LEGACY_EMBEDDED_POSTGRES_PASSWORD = "paperclip";

function passwordFile(env: NodeJS.ProcessEnv): string | null {
  const file = env[EMBEDDED_POSTGRES_PASSWORD_FILE_ENV]?.trim();
  if (!file) return null;
  if (!path.isAbsolute(file)) {
    throw new Error(`${EMBEDDED_POSTGRES_PASSWORD_FILE_ENV} must be an absolute path (it is "${file}")`);
  }
  return file;
}

function readPasswordFile(file: string): string {
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${file} is readable by others (mode ${mode.toString(8)}): it must be readable by its owner alone`);
  }
  const password = readFileSync(file, "utf8").trim();
  if (!password) throw new Error(`${file} holds no password`);
  return password;
}

/**
 * Made whole and private, or not at all, and never over another process's: the password is written to a private
 * temporary file and linked into place, which fails when the file appeared meanwhile; that one is read instead.
 */
function createPasswordFile(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString("hex");
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${password}\n`, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, file);
    return password;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readPasswordFile(file);
    throw error;
  } finally {
    unlinkSync(temporary);
  }
}

/** The password the embedded cluster's role has, or is given: the file's when one is configured, else the fixed one. */
export function embeddedPostgresPassword(env: NodeJS.ProcessEnv = process.env): string {
  const file = passwordFile(env);
  if (!file) return LEGACY_EMBEDDED_POSTGRES_PASSWORD;
  try {
    return readPasswordFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return createPasswordFile(file);
    throw error;
  }
}

/** A connection string for the embedded cluster on PORT, as its role `paperclip`. */
export function embeddedPostgresUrl(
  port: number,
  database: string,
  password: string = embeddedPostgresPassword(),
): string {
  return `postgres://paperclip:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

type Probe = "ok" | "password" | "unreachable";

async function probe(url: string): Promise<{ result: Probe; dataDirectory?: string; error?: unknown }> {
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try {
    const rows = await sql<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    return { result: "ok", dataDirectory: rows[0]?.data_directory ?? undefined };
  } catch (error) {
    // 28P01 invalid_password, 28000 invalid_authorization_specification
    const code = (error as { code?: string }).code;
    return { result: code === "28P01" || code === "28000" ? "password" : "unreachable", error };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Before anything else connects to the embedded cluster on PORT, whose data directory is DATA_DIR: when a password
 * file is configured and the role still has the fixed password, give the role the file's password. Only the cluster
 * of DATA_DIR is changed, and only when the fixed password reaches it. Returns what it found: `unchanged` (no file,
 * or the role already has the file's password) or `set`. Throws when neither password reaches the cluster, or when
 * nothing answers on PORT.
 */
export async function adoptEmbeddedPostgresPassword(
  port: number,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<"unchanged" | "set"> {
  const password = embeddedPostgresPassword(env);
  if (password === LEGACY_EMBEDDED_POSTGRES_PASSWORD) return "unchanged";
  const current = await probe(embeddedPostgresUrl(port, "postgres", password));
  if (current.result === "ok") return "unchanged";
  if (current.result === "unreachable") throw current.error;
  const legacy = await probe(embeddedPostgresUrl(port, "postgres", LEGACY_EMBEDDED_POSTGRES_PASSWORD));
  if (legacy.result !== "ok") {
    throw new Error(
      `The embedded PostgreSQL role on port ${port} takes neither the password in ${passwordFile(env)} nor the fixed one`,
    );
  }
  if (typeof legacy.dataDirectory !== "string" || path.resolve(legacy.dataDirectory) !== path.resolve(dataDir)) {
    throw new Error(`Refusing to change the password of the PostgreSQL on port ${port}: its data directory is not ${dataDir}`);
  }
  const sql = postgres(embeddedPostgresUrl(port, "postgres", LEGACY_EMBEDDED_POSTGRES_PASSWORD), {
    max: 1,
    onnotice: () => {},
  });
  try {
    await sql.unsafe(`ALTER ROLE paperclip WITH PASSWORD ${quoteLiteral(password)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return "set";
}
