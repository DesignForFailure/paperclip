import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_PASSWORD_FILE_ENV,
  LEGACY_EMBEDDED_POSTGRES_PASSWORD,
  adoptEmbeddedPostgresPassword,
  embeddedPostgresPassword,
  embeddedPostgresUrl,
} from "./embedded-postgres-password.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function folder(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-db-password-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function envWith(file: string): NodeJS.ProcessEnv {
  return { [EMBEDDED_POSTGRES_PASSWORD_FILE_ENV]: file };
}

describe("embeddedPostgresPassword", () => {
  it("is the fixed upstream password when no file is configured", () => {
    expect(embeddedPostgresPassword({})).toBe(LEGACY_EMBEDDED_POSTGRES_PASSWORD);
    expect(embeddedPostgresPassword({ [EMBEDDED_POSTGRES_PASSWORD_FILE_ENV]: "  " })).toBe("paperclip");
  });

  it("makes the file once, random and readable by its owner alone, in a private folder", () => {
    const file = path.join(folder(), "secrets", "postgres-password");
    const first = embeddedPostgresPassword(envWith(file));
    expect(first).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, "utf8")).toBe(`${first}\n`);
    expect(embeddedPostgresPassword(envWith(file))).toBe(first);
    // No temporary file is left beside it.
    expect(readdirSync(path.dirname(file))).toEqual(["postgres-password"]);
  });

  it("reads a file that is there and never replaces it", () => {
    const file = path.join(folder(), "postgres-password");
    writeFileSync(file, "kept-password\n", { mode: 0o600 });
    expect(embeddedPostgresPassword(envWith(file))).toBe("kept-password");
    expect(readFileSync(file, "utf8")).toBe("kept-password\n");
  });

  it("refuses a file others can read, an empty one, and a relative path", () => {
    const dir = folder();
    const open = path.join(dir, "open");
    writeFileSync(open, "secret\n");
    chmodSync(open, 0o644);
    expect(() => embeddedPostgresPassword(envWith(open))).toThrow(/readable by others/);
    const empty = path.join(dir, "empty");
    writeFileSync(empty, "\n", { mode: 0o600 });
    expect(() => embeddedPostgresPassword(envWith(empty))).toThrow(/holds no password/);
    expect(() => embeddedPostgresPassword(envWith("relative/password"))).toThrow(/absolute path/);
  });
});

describe("embeddedPostgresUrl", () => {
  it("names the role and encodes its password", () => {
    expect(embeddedPostgresUrl(54329, "paperclip", "paperclip")).toBe("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
    expect(embeddedPostgresUrl(5, "postgres", "a b@c/d:e")).toBe("postgres://paperclip:a%20b%40c%2Fd%3Ae@127.0.0.1:5/postgres");
  });
});

describe("adoptEmbeddedPostgresPassword without a file", () => {
  it("changes nothing and connects to nothing", async () => {
    // Port 1 answers nothing: a connection attempt would throw.
    await expect(adoptEmbeddedPostgresPassword(1, "/nowhere", {})).resolves.toBe("unchanged");
  });
});

describePostgres("adoptEmbeddedPostgresPassword on an embedded cluster", () => {
  async function cluster() {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-db-password-cluster-");
    cleanups.push(() => db.cleanup());
    const port = Number(new URL(db.connectionString).port);
    const sql = postgres(embeddedPostgresUrl(port, "postgres", LEGACY_EMBEDDED_POSTGRES_PASSWORD), { max: 1 });
    const [{ data_directory: dataDir }] = await sql<{ data_directory: string }[]>`SHOW data_directory`;
    await sql.end();
    return { port, dataDir };
  }

  async function connects(port: number, password: string): Promise<boolean | string> {
    const sql = postgres(embeddedPostgresUrl(port, "postgres", password), { max: 1, onnotice: () => {} });
    try {
      await sql`SELECT 1`;
      return true;
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it("gives a cluster made with the fixed password the file's, once", async () => {
    const { port, dataDir } = await cluster();
    const env = envWith(path.join(folder(), "postgres-password"));
    await expect(adoptEmbeddedPostgresPassword(port, dataDir, env)).resolves.toBe("set");
    const password = embeddedPostgresPassword(env);
    expect(await connects(port, password)).toBe(true);
    expect(await connects(port, LEGACY_EMBEDDED_POSTGRES_PASSWORD)).toBe("28P01");
    await expect(adoptEmbeddedPostgresPassword(port, dataDir, env)).resolves.toBe("unchanged");
  }, 120_000);

  it("leaves a cluster of another data directory as it is", async () => {
    const { port } = await cluster();
    const env = envWith(path.join(folder(), "postgres-password"));
    await expect(adoptEmbeddedPostgresPassword(port, "/somewhere/else", env)).rejects.toThrow(/data directory is not/);
    expect(await connects(port, LEGACY_EMBEDDED_POSTGRES_PASSWORD)).toBe(true);
  }, 120_000);

  it("refuses a cluster whose role takes neither password", async () => {
    const { port, dataDir } = await cluster();
    const env = envWith(path.join(folder(), "postgres-password"));
    const sql = postgres(embeddedPostgresUrl(port, "postgres", LEGACY_EMBEDDED_POSTGRES_PASSWORD), { max: 1 });
    await sql.unsafe("ALTER ROLE paperclip WITH PASSWORD 'a-third-one'");
    await sql.end();
    await expect(adoptEmbeddedPostgresPassword(port, dataDir, env)).rejects.toThrow(/neither the password/);
    expect(await connects(port, "a-third-one")).toBe(true);
    // Put back what the test support's cleanup connects with.
    const back = postgres(embeddedPostgresUrl(port, "postgres", "a-third-one"), { max: 1 });
    await back.unsafe("ALTER ROLE paperclip WITH PASSWORD 'paperclip'");
    await back.end();
  }, 120_000);
});
