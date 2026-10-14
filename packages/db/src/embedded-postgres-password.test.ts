import fs, { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_PASSWORD_FILE_ENV,
  LEGACY_EMBEDDED_POSTGRES_PASSWORD,
  EmbeddedPostgresFixedPasswordError,
  adoptEmbeddedPostgresPasswordPrivately,
  checkEmbeddedPostgresPassword,
  embeddedPostgresPassword,
  embeddedPostgresUrl,
} from "./embedded-postgres-password.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import { getEmbeddedPostgresTestSupport } from "./test-embedded-postgres.js";

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

describe("checkEmbeddedPostgresPassword without a file", () => {
  it("changes nothing and connects to nothing", async () => {
    // Port 1 answers nothing: a connection attempt would throw.
    await expect(checkEmbeddedPostgresPassword(1, "/nowhere", {})).resolves.toBe("unchanged");
  });
});

describe("adoptEmbeddedPostgresPasswordPrivately without anything to do", () => {
  it("starts nothing without a file, or for a cluster not made yet", async () => {
    const createInstance = vi.fn();
    await expect(adoptEmbeddedPostgresPasswordPrivately({ dataDir: folder(), port: 1, createInstance, env: {} }))
      .resolves.toBe("unchanged");
    const env = envWith(path.join(folder(), "postgres-password"));
    await expect(adoptEmbeddedPostgresPasswordPrivately({ dataDir: folder(), port: 1, createInstance, env }))
      .resolves.toBe("unchanged");
    expect(createInstance).not.toHaveBeenCalled();
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

async function tcpRefused(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(true));
  });
}

describePostgres("the embedded cluster's password on a real cluster", () => {
  type Instance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
  type Ctor = new (options: Record<string, unknown>) => Instance;

  /** A cluster made with the fixed password, as every cluster before the file was, and stopped. */
  async function legacyCluster() {
    await prepareEmbeddedPostgresNativeRuntime();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as unknown as Ctor;
    const dataDir = path.join(folder(), "db");
    const port = await freePort();
    const make = (postgresFlags: string[] = []) => new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "paperclip",
      password: LEGACY_EMBEDDED_POSTGRES_PASSWORD,
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      postgresFlags,
      onLog: () => {},
      onError: () => {},
    });
    await make().initialise();
    return { dataDir, port, make };
  }

  /** Started on its TCP port until the test ends. */
  async function started(make: (flags?: string[]) => Instance) {
    const instance = make();
    await instance.start();
    cleanups.push(() => instance.stop());
    return instance;
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

  it("gives a cluster made with the fixed password the file's while it listens on no TCP port", async () => {
    const { dataDir, port, make } = await legacyCluster();
    const env = envWith(path.join(folder(), "postgres-password"));
    const flagsSeen: string[][] = [];
    const tcpWhileAdopting: boolean[] = [];
    const createInstance = (postgresFlags: string[]) => {
      flagsSeen.push(postgresFlags);
      const instance = make(postgresFlags);
      return {
        start: async () => {
          await instance.start();
          tcpWhileAdopting.push(await tcpRefused(port));
        },
        stop: () => instance.stop(),
      };
    };
    await expect(adoptEmbeddedPostgresPasswordPrivately({ dataDir, port, createInstance, env })).resolves.toBe("set");
    expect(flagsSeen).toHaveLength(1);
    expect(flagsSeen[0]?.slice(0, 2)).toEqual(["-c", "listen_addresses="]);
    expect(tcpWhileAdopting).toEqual([true]);
    // Its socket folder is gone, and the cluster is stopped.
    expect(fs.existsSync(flagsSeen[0]![3]!)).toBe(false);
    expect(await tcpRefused(port)).toBe(true);

    await started(make);
    const password = embeddedPostgresPassword(env);
    expect(await connects(port, password)).toBe(true);
    expect(await connects(port, LEGACY_EMBEDDED_POSTGRES_PASSWORD)).toBe("28P01");
    await expect(checkEmbeddedPostgresPassword(port, dataDir, env)).resolves.toBe("unchanged");
    // Known to have it now: not started privately again.
    const again = vi.fn();
    await expect(adoptEmbeddedPostgresPasswordPrivately({ dataDir, port, createInstance: again, env })).resolves.toBe("unchanged");
    expect(again).not.toHaveBeenCalled();
  }, 120_000);

  it("never changes the password over TCP: a running cluster with the fixed one is refused as it is", async () => {
    const { dataDir, port, make } = await legacyCluster();
    await started(make);
    const env = envWith(path.join(folder(), "postgres-password"));
    await expect(checkEmbeddedPostgresPassword(port, dataDir, env)).rejects.toBeInstanceOf(EmbeddedPostgresFixedPasswordError);
    expect(await connects(port, LEGACY_EMBEDDED_POSTGRES_PASSWORD)).toBe(true);
    // Another instance's cluster on the port is not this one's to stop: a plain error, so a caller can go on elsewhere.
    const other = checkEmbeddedPostgresPassword(port, path.join(folder(), "another-db"), env);
    await expect(other).rejects.toThrow(/is not the embedded cluster of/);
    await expect(other).rejects.not.toBeInstanceOf(EmbeddedPostgresFixedPasswordError);
  }, 120_000);

  it("refuses a cluster whose role takes neither password, and leaves it stopped", async () => {
    const { dataDir, port, make } = await legacyCluster();
    const running = make();
    await running.start();
    const sql = postgres(embeddedPostgresUrl(port, "postgres", LEGACY_EMBEDDED_POSTGRES_PASSWORD), { max: 1 });
    await sql.unsafe("ALTER ROLE paperclip WITH PASSWORD 'a-third-one'");
    await sql.end();
    await running.stop();
    const env = envWith(path.join(folder(), "postgres-password"));
    await expect(adoptEmbeddedPostgresPasswordPrivately({ dataDir, port, createInstance: make, env }))
      .rejects.toThrow(/neither the password/);
    expect(await tcpRefused(port)).toBe(true);
  }, 120_000);
});
