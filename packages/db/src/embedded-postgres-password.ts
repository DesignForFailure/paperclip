import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";

/**
 * The embedded PostgreSQL role's password.
 *
 * Upstream every embedded cluster's role `paperclip` has the fixed password `paperclip`, so any local process can
 * reach the database on its loopback port. With PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE set, the password is that
 * file's content instead: made once, random and readable by its owner alone, when the file is absent and its cluster
 * was never given one (else the file must be restored). A cluster, new (made with the fixed password, which is all
 * initdb's temporary file then holds) or made before the file, is given it once, while it listens on no TCP port and on
 * a Unix socket in a private folder only, so no other process can use the fixed password meanwhile
 * (`adoptEmbeddedPostgresPasswordPrivately`). Over TCP the password is only checked, never changed
 * (`checkEmbeddedPostgresPassword`). Unset, nothing changes.
 */
export const EMBEDDED_POSTGRES_PASSWORD_FILE_ENV = "PAPERCLIP_EMBEDDED_POSTGRES_PASSWORD_FILE";
export const LEGACY_EMBEDDED_POSTGRES_PASSWORD = "paperclip";

/**
 * The password a new cluster is made with: always the fixed one. embedded-postgres hands initdb the role's password in
 * a file it writes to the system temporary folder with the default mode (readable by every local user under umask 022)
 * and leaves there when initdb fails, so the configured password never goes through it. A new cluster is given the
 * configured one by `adoptEmbeddedPostgresPasswordPrivately`, with no TCP listener, before it first starts on its port:
 * every caller runs that between `initialise()` and `start()`.
 */
export const EMBEDDED_POSTGRES_INITDB_PASSWORD = LEGACY_EMBEDDED_POSTGRES_PASSWORD;

/** Beside the cluster's files: a digest of the password the cluster is known to have, so it is not started privately again. */
const PASSWORD_MARKER = "paperclip-role-password.sha256";

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

/**
 * The password the embedded cluster's role has, or is given: the file's when one is configured, else the fixed one.
 * A missing file is made only for the cluster of DATA_DIR, and only when that cluster was never given a password from a
 * file (no marker in it): a new random file would not open a cluster that keeps the old password, so that file must be
 * restored instead. Without DATA_DIR a missing file is an error, never made.
 */
export function embeddedPostgresPassword(env: NodeJS.ProcessEnv = process.env, dataDir?: string): string {
  const file = passwordFile(env);
  if (!file) return LEGACY_EMBEDDED_POSTGRES_PASSWORD;
  try {
    return readPasswordFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!dataDir) {
      throw new Error(
        `The embedded PostgreSQL password file ${file} is missing. Paperclip makes it when it first starts its embedded `
          + "database; if that database exists already, restore the file.",
      );
    }
    if (existsSync(path.join(dataDir, PASSWORD_MARKER))) {
      throw new Error(
        `The embedded PostgreSQL password file ${file} is missing, but the cluster in ${dataDir} was given the password `
          + "it held. Restore that file: a new password would not open the cluster.",
      );
    }
    return createPasswordFile(file);
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

/** Where to reach the cluster: its loopback TCP port, or a Unix socket folder and the port its socket is named by. */
type Target = { port: number; socketDir?: string };

function client(target: Target, password: string) {
  return postgres({
    host: target.socketDir ?? "127.0.0.1",
    port: target.port,
    user: "paperclip",
    password,
    database: "postgres",
    max: 1,
    onnotice: () => {},
    connect_timeout: 10,
  });
}

async function probe(target: Target, password: string): Promise<{ result: Probe; dataDirectory?: string; error?: unknown }> {
  const sql = client(target, password);
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

function digest(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

function knownToHave(dataDir: string, password: string): boolean {
  try {
    return readFileSync(path.join(dataDir, PASSWORD_MARKER), "utf8").trim() === digest(password);
  } catch {
    return false;
  }
}

function markHas(dataDir: string, password: string): void {
  writeFileSync(path.join(dataDir, PASSWORD_MARKER), `${digest(password)}\n`, { mode: 0o600 });
}

/** The cluster on a port still takes the fixed password, which is changed only while it listens on no TCP port. */
export class EmbeddedPostgresFixedPasswordError extends Error {
  constructor(port: number) {
    super(
      `The embedded PostgreSQL on port ${port} still has the fixed password. Stop it and start Paperclip again: `
        + `the password in ${EMBEDDED_POSTGRES_PASSWORD_FILE_ENV} is given to it while it listens on no TCP port.`,
    );
    this.name = "EmbeddedPostgresFixedPasswordError";
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The postmaster.pid lines of DATA_DIR's running server (pid, data directory, start, port, socket folder, listen address, ...), or null. */
function runningPostmaster(dataDir: string): string[] | null {
  let lines: string[];
  try {
    lines = readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n");
  } catch {
    return null;
  }
  const pid = Number(lines[0]);
  return Number.isSafeInteger(pid) && pid > 0 && isRunning(pid) ? lines : null;
}

/**
 * DATA_DIR's server runs and listens on no TCP port: the private start of `adoptEmbeddedPostgresPasswordPrivately`,
 * left running when the process that started it was killed.
 */
export class EmbeddedPostgresNoTcpListenerError extends Error {
  constructor(dataDir: string, pid: number) {
    super(
      `The embedded PostgreSQL of ${dataDir} is running with no TCP listener (pid ${pid}): a Paperclip start was stopped `
        + `while it gave the cluster its password privately. Stop that server (kill -INT ${pid}) and start Paperclip again.`,
    );
    this.name = "EmbeddedPostgresNoTcpListenerError";
  }
}

/**
 * The embedded cluster on PORT, whose data directory is DATA_DIR, takes the configured password, checked over TCP and
 * never changed there. `unchanged` when no file is configured or the role has the file's password; throws
 * EmbeddedPostgresFixedPasswordError when DATA_DIR's cluster still has the fixed one, and another error when the fixed
 * one opens another PostgreSQL, when neither opens it, or when nothing answers.
 */
export async function checkEmbeddedPostgresPassword(
  port: number,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<"unchanged"> {
  const password = embeddedPostgresPassword(env, dataDir);
  if (password === LEGACY_EMBEDDED_POSTGRES_PASSWORD) return "unchanged";
  const current = await probe({ port }, password);
  if (current.result === "ok") {
    if (current.dataDirectory && path.resolve(current.dataDirectory) === path.resolve(dataDir)) markHas(dataDir, password);
    return "unchanged";
  }
  if (current.result === "unreachable") {
    // Line 6 of postmaster.pid is the first listen address, empty for a server with no TCP listener.
    const running = runningPostmaster(dataDir);
    if (running && running.length > 5 && running[5]!.trim() === "") {
      throw new EmbeddedPostgresNoTcpListenerError(dataDir, Number(running[0]));
    }
    throw current.error;
  }
  const legacy = await probe({ port }, LEGACY_EMBEDDED_POSTGRES_PASSWORD);
  if (legacy.result === "ok") {
    // Only this instance's cluster is the one to stop and start again; another PostgreSQL on the port is not it, and a
    // caller may go on to a free port (Codex, paperclip#9).
    if (typeof legacy.dataDirectory === "string" && path.resolve(legacy.dataDirectory) === path.resolve(dataDir)) {
      throw new EmbeddedPostgresFixedPasswordError(port);
    }
    throw new Error(`The PostgreSQL on port ${port} is not the embedded cluster of ${dataDir}`);
  }
  throw new Error(
    `The embedded PostgreSQL role on port ${port} takes neither the password in ${passwordFile(env)} nor the fixed one`,
  );
}

/** An embedded cluster's instance as `embedded-postgres` makes it. */
export type EmbeddedPostgresPrivateInstance = { start(): Promise<void>; stop(): Promise<void> };

const SOCKET_DIR_PREFIX = "paperclip-pg-";
/** A Unix socket path's longest: sun_path holds 108 bytes on Linux and 104 elsewhere, its closing NUL among them. */
const SOCKET_PATH_MAX = process.platform === "linux" ? 107 : 103;

/**
 * A new folder readable by its owner alone (mkdtemp's mode) for the private start's socket, in the temporary folder
 * when the socket's path fits there and in /tmp when TMPDIR is too long for it.
 */
function privateSocketDir(port: number): string {
  const socketName = `.s.PGSQL.${port}`;
  const bases = process.platform === "win32" ? [os.tmpdir()] : [os.tmpdir(), "/tmp"];
  for (const base of bases) {
    // mkdtemp adds six characters to the prefix.
    if (Buffer.byteLength(path.join(base, `${SOCKET_DIR_PREFIX}XXXXXX`, socketName)) <= SOCKET_PATH_MAX) {
      return mkdtempSync(path.join(base, SOCKET_DIR_PREFIX));
    }
  }
  throw new Error(
    `No temporary folder gives the embedded PostgreSQL's private socket a path of ${SOCKET_PATH_MAX} bytes or fewer `
      + `(TMPDIR is ${os.tmpdir()}). Set TMPDIR to a shorter folder and start Paperclip again.`,
  );
}

/**
 * Stops the private start of DATA_DIR's server. `embedded-postgres`'s stop() waits for an exit event: for a server that
 * has exited already it would wait for ever, so it is called only for a running server, and the wait also ends when
 * the server's pid is gone.
 */
async function stopPrivateStart(instance: EmbeddedPostgresPrivateInstance, dataDir: string): Promise<void> {
  const running = runningPostmaster(dataDir);
  if (!running) return;
  const pid = Number(running[0]);
  let poll: NodeJS.Timeout | undefined;
  const exited = new Promise<void>((resolve) => {
    poll = setInterval(() => {
      if (!isRunning(pid)) resolve();
    }, 100);
  });
  try {
    await Promise.race([instance.stop(), exited]);
  } finally {
    clearInterval(poll);
  }
}

/**
 * Before the existing cluster of DATA_DIR is started on its TCP port: when a password file is configured and the
 * cluster is not known to have its password, start it with no TCP listener and its socket in a new private folder
 * (CREATE_INSTANCE makes the instance with the given postgres flags), give the role the file's password there when it
 * still has the fixed one, and stop it. No other process can reach it meanwhile. `unchanged` when nothing was to do or
 * the role already had the file's password, `set` when it was given it; throws when neither password opens it.
 */
export async function adoptEmbeddedPostgresPasswordPrivately(input: {
  dataDir: string;
  port: number;
  createInstance: (postgresFlags: string[]) => EmbeddedPostgresPrivateInstance;
  env?: NodeJS.ProcessEnv;
}): Promise<"unchanged" | "set"> {
  const env = input.env ?? process.env;
  const password = embeddedPostgresPassword(env, input.dataDir);
  if (password === LEGACY_EMBEDDED_POSTGRES_PASSWORD) return "unchanged";
  if (!existsSync(path.join(input.dataDir, "PG_VERSION"))) return "unchanged";
  if (knownToHave(input.dataDir, password)) return "unchanged";

  // The socket's folder is readable by its owner alone: the socket in it is reachable by no one else.
  const socketDir = privateSocketDir(input.port);
  const target = { port: input.port, socketDir };
  const instance = input.createInstance(["-c", "listen_addresses=", "-k", socketDir]);
  let started = false;
  try {
    await instance.start();
    started = true;
    let result: "unchanged" | "set" = "unchanged";
    const current = await probe(target, password);
    if (current.result !== "ok") {
      if (current.result === "unreachable") throw current.error;
      const legacy = await probe(target, LEGACY_EMBEDDED_POSTGRES_PASSWORD);
      if (legacy.result !== "ok") {
        throw new Error(
          `The embedded PostgreSQL role of ${input.dataDir} takes neither the password in ${passwordFile(env)} nor the fixed one`,
        );
      }
      const sql = client(target, LEGACY_EMBEDDED_POSTGRES_PASSWORD);
      try {
        await sql.unsafe(`ALTER ROLE paperclip WITH PASSWORD ${quoteLiteral(password)}`);
      } finally {
        await sql.end({ timeout: 5 });
      }
      result = "set";
    }
    markHas(input.dataDir, password);
    return result;
  } finally {
    // A start that failed has exited already (start() rejects when the server closes): nothing to stop.
    if (started) await stopPrivateStart(instance, input.dataDir);
    rmSync(socketDir, { recursive: true, force: true });
  }
}
