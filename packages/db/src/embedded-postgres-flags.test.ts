import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBEDDED_POSTGRES_FLAGS_ENV, embeddedPostgresFlags } from "./embedded-postgres-flags.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import { embeddedPostgresUrl } from "./embedded-postgres-password.js";
import { resolveMigrationConnection } from "./migration-runtime.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport } from "./test-embedded-postgres.js";

/**
 * PAPERCLIP_EMBEDDED_POSTGRES_FLAGS (a fork setting, for Continuum): server settings for the embedded cluster, given
 * as `-c key=value` at every start. Unset, nothing changes.
 */
const cleanups: Array<() => Promise<void> | void> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length) await cleanups.pop()?.();
});

const flagsOf = (value: string | undefined) => embeddedPostgresFlags(value === undefined ? {} : { [EMBEDDED_POSTGRES_FLAGS_ENV]: value });

describe("embeddedPostgresFlags", () => {
  it("is nothing when unset, empty or blank, so the cluster keeps PostgreSQL's defaults", () => {
    expect(flagsOf(undefined)).toEqual([]);
    expect(flagsOf("")).toEqual([]);
    expect(flagsOf(" \n\t ")).toEqual([]);
  });

  it("gives each whitespace-separated key=value pair as -c key=value, in order", () => {
    expect(flagsOf("  shared_buffers=64MB\tmax_connections=20\n work_mem=2MB  max_parallel_workers=2 ")).toEqual([
      "-c", "shared_buffers=64MB",
      "-c", "max_connections=20",
      "-c", "work_mem=2MB",
      "-c", "max_parallel_workers=2",
    ]);
    // A dotted (extension) name and a value with '=' or quotes in it are passed as given; PostgreSQL checks them.
    expect(flagsOf("auto_explain.log_min_duration=250ms search_path='a,b' x.y=a=b")).toEqual([
      "-c", "auto_explain.log_min_duration=250ms",
      "-c", "search_path='a,b'",
      "-c", "x.y=a=b",
    ]);
  });

  it("refuses anything that is not key=value, naming the variable and the pair", () => {
    for (const [value, pair] of [
      ["shared_buffers", "shared_buffers"],
      ["shared_buffers=", "shared_buffers="],
      ["=64MB", "=64MB"],
      ["-c shared_buffers=64MB", "-c"],
      ["--shared_buffers=64MB", "--shared_buffers=64MB"],
      ["shared_buffers=64MB 9lives=1", "9lives=1"],
      ["work-mem=2MB", "work-mem=2MB"],
    ] as const) {
      expect(() => flagsOf(value), value).toThrow(`${EMBEDDED_POSTGRES_FLAGS_ENV}: "${pair}" is not a key=value setting`);
    }
  });

  it("refuses the settings Paperclip decides for the cluster: where it listens and its files", () => {
    for (const key of ["port", "listen_addresses", "unix_socket_directories", "data_directory", "config_file", "hba_file", "ident_file", "LISTEN_ADDRESSES"]) {
      expect(() => flagsOf(`work_mem=2MB ${key}=x`), key).toThrow(`${EMBEDDED_POSTGRES_FLAGS_ENV}: "${key}" is decided by Paperclip`);
    }
  });

  it("reads process.env by default", () => {
    vi.stubEnv(EMBEDDED_POSTGRES_FLAGS_ENV, "work_mem=2MB");
    expect(embeddedPostgresFlags()).toEqual(["-c", "work_mem=2MB"]);
  });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

describePostgres("PAPERCLIP_EMBEDDED_POSTGRES_FLAGS on a real cluster", () => {
  /** `db:migrate`'s cluster (migration-runtime), started for a config of its own with the flags given, and its settings. */
  async function settingsOfMigrationCluster(flags: string | undefined, envFile?: string) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-db-flags-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const port = await freePort();
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      database: { mode: "embedded-postgres", embeddedPostgresDataDir: path.join(dir, "db"), embeddedPostgresPort: port },
    }));
    vi.stubEnv("PAPERCLIP_CONFIG", configPath);
    vi.stubEnv("DATABASE_URL", "");
    // Stubbed either way, so a value in the environment the suite runs in is not read; with an instance .env, `undefined`
    // takes the variable out of the environment.
    if (envFile !== undefined) writeFileSync(path.join(dir, ".env"), envFile);
    vi.stubEnv(EMBEDDED_POSTGRES_FLAGS_ENV, envFile !== undefined ? flags : flags ?? "");
    const connection = await resolveMigrationConnection();
    cleanups.push(() => connection.stop());
    const sql = postgres(embeddedPostgresUrl(port, "postgres"), { max: 1, onnotice: () => {} });
    try {
      const rows = await sql<{ name: string; value: string }[]>`
        SELECT name, current_setting(name) AS value FROM pg_settings
        WHERE name IN ('shared_buffers', 'max_connections', 'work_mem', 'max_parallel_workers')`;
      return Object.fromEntries(rows.map((row) => [row.name, row.value]));
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it("starts the cluster with the settings, and without them PostgreSQL's defaults", async () => {
    expect(await settingsOfMigrationCluster("shared_buffers=64MB max_connections=20 work_mem=2MB max_parallel_workers=2")).toEqual({
      shared_buffers: "64MB",
      max_connections: "20",
      work_mem: "2MB",
      max_parallel_workers: "2",
    });
    while (cleanups.length) await cleanups.pop()?.();
    vi.unstubAllEnvs();
    expect(await settingsOfMigrationCluster(undefined)).toEqual({
      shared_buffers: "128MB",
      max_connections: "100",
      work_mem: "4MB",
      max_parallel_workers: "8",
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS * 2);

  it("reads the instance's .env when the environment does not set it, as the server's start does", async () => {
    const file = `# instance env\nDATABASE_URL=\n${EMBEDDED_POSTGRES_FLAGS_ENV}="shared_buffers=64MB max_connections=20"\n`;
    expect(await settingsOfMigrationCluster(undefined, file)).toMatchObject({ shared_buffers: "64MB", max_connections: "20" });
    while (cleanups.length) await cleanups.pop()?.();
    vi.unstubAllEnvs();
    // The environment's value wins, even an empty one (dotenv's override: false).
    expect(await settingsOfMigrationCluster("", file)).toMatchObject({ shared_buffers: "128MB", max_connections: "100" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS * 2);

  it("refuses a malformed setting before any cluster is started", async () => {
    await expect(settingsOfMigrationCluster("shared_buffers")).rejects.toThrow(/is not a key=value setting/);
    const dir = path.dirname(process.env.PAPERCLIP_CONFIG!);
    expect(existsSync(path.join(dir, "db"))).toBe(false);
  });

  it("lets a start's own flags, given after the configured ones, win (the private password start's)", async () => {
    await prepareEmbeddedPostgresNativeRuntime();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as unknown as new (options: Record<string, unknown>) => {
      initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>;
    };
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-db-flags-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const port = await freePort();
    const instance = new EmbeddedPostgres({
      databaseDir: path.join(dir, "db"),
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      postgresFlags: [...flagsOf("work_mem=2MB max_connections=20"), "-c", "work_mem=8MB"],
      onLog: () => {},
      onError: () => {},
    });
    await instance.initialise();
    await instance.start();
    cleanups.push(() => instance.stop());
    const sql = postgres(embeddedPostgresUrl(port, "postgres", "paperclip"), { max: 1, onnotice: () => {} });
    try {
      const [row] = await sql<{ work_mem: string; max_connections: string }[]>`
        SELECT current_setting('work_mem') AS work_mem, current_setting('max_connections') AS max_connections`;
      expect(row).toEqual({ work_mem: "8MB", max_connections: "20" });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
