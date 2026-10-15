import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { ensurePostgresDatabase, getPostgresDataDirectory } from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import {
  EmbeddedPostgresFixedPasswordError,
  adoptEmbeddedPostgresPasswordPrivately,
  checkEmbeddedPostgresPassword,
  EMBEDDED_POSTGRES_INITDB_PASSWORD,
  embeddedPostgresUrl,
} from "./embedded-postgres-password.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  postgresFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type MigrationConnection = {
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function readPidFilePort(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  const maxLookahead = 20;
  let port = startPort;
  for (let i = 0; i < maxLookahead; i += 1, port += 1) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(
    `Embedded PostgreSQL could not find a free port from ${startPort} to ${startPort + maxLookahead - 1}`,
  );
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  try {
    const mod = await import("embedded-postgres");
    return mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
): Promise<MigrationConnection> {
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  await prepareEmbeddedPostgresNativeRuntime();
  const selectedPort = await findAvailablePort(preferredPort);
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const pgVersionFile = path.resolve(dataDir, "PG_VERSION");
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  const runningPort = readPidFilePort(postmasterPidFile);
  const logBuffer = createEmbeddedPostgresLogBuffer();

  if (!runningPid && existsSync(pgVersionFile)) {
    try {
      // The check reads the password knowing the data directory, so a missing file is made only where it may be.
      await checkEmbeddedPostgresPassword(preferredPort, dataDir);
      const preferredAdminConnectionString = embeddedPostgresUrl(preferredPort, "postgres");
      const actualDataDir = await getPostgresDataDirectory(preferredAdminConnectionString);
      const matchesDataDir =
        typeof actualDataDir === "string" &&
        path.resolve(actualDataDir) === path.resolve(dataDir);
      if (!matchesDataDir) {
        throw new Error("reachable postgres does not use the expected embedded data directory");
      }
      await ensurePostgresDatabase(preferredAdminConnectionString, "paperclip");
      process.emitWarning(
        `Adopting an existing PostgreSQL instance on port ${preferredPort} for embedded data dir ${dataDir} because postmaster.pid is missing.`,
      );
      return {
        connectionString: embeddedPostgresUrl(preferredPort, "paperclip"),
        source: `embedded-postgres@${preferredPort}`,
        stop: async () => {},
      };
    } catch (error) {
      // A running cluster that still has the fixed password is not started again beside it.
      if (error instanceof EmbeddedPostgresFixedPasswordError) throw error;
      // Fall through and attempt to start the configured embedded cluster.
    }
  }

  if (runningPid) {
    const port = runningPort ?? preferredPort;
    await checkEmbeddedPostgresPassword(port, dataDir);
    const adminConnectionString = embeddedPostgresUrl(port, "postgres");
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    return {
      connectionString: embeddedPostgresUrl(port, "paperclip"),
      source: `embedded-postgres@${port}`,
      stop: async () => {},
    };
  }

  const createInstance = (postgresFlags: string[] = []) => new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    // The fixed password for initdb's temporary file; the configured one is given privately before the first start.
    password: EMBEDDED_POSTGRES_INITDB_PASSWORD,
    port: selectedPort,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    postgresFlags,
    onLog: logBuffer.append,
    onError: logBuffer.append,
  });
  const instance = createInstance();

  if (!existsSync(path.resolve(dataDir, "PG_VERSION"))) {
    try {
      await instance.initialise();
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage:
          `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${selectedPort}`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }
  if (existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }
  // A cluster made before the configured password file is given its password with no TCP listener first.
  await adoptEmbeddedPostgresPasswordPrivately({ dataDir, port: selectedPort, createInstance });
  try {
    await instance.start();
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `Failed to start embedded PostgreSQL on port ${selectedPort}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  await checkEmbeddedPostgresPassword(selectedPort, dataDir);
  const adminConnectionString = embeddedPostgresUrl(selectedPort, "postgres");
  await ensurePostgresDatabase(adminConnectionString, "paperclip");

  return {
    connectionString: embeddedPostgresUrl(selectedPort, "paperclip"),
    source: `embedded-postgres@${selectedPort}`,
    stop: async () => {
      await instance.stop();
    },
  };
}

export async function resolveMigrationConnection(): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      connectionString: target.connectionString,
      source: target.source,
      stop: async () => {},
    };
  }

  return ensureEmbeddedPostgresConnection(target.dataDir, target.port);
}
