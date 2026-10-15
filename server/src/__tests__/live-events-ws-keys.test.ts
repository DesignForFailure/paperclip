import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, authUsers, boardApiKeys, companies, companyMemberships, createDb } from "@paperclipai/db";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * The live-events socket against a real database: which keys open it, and that a key revoked or expired after the
 * upgrade loses its open socket at the next ping (every 30 s), as its next HTTP request would be refused.
 */

const require = createRequire(import.meta.url);
type Client = {
  on(event: "open", listener: () => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "unexpected-response", listener: (req: unknown, res: { statusCode?: number }) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  close(): void;
  terminate(): void;
  readyState: number;
};
const { WebSocket } = require("ws") as {
  WebSocket: { new (url: string, options?: { headers?: Record<string, string> }): Client; OPEN: number };
};

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe.sequential : describe.skip;

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describePostgres("live-events socket: keys against a real database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: Server | null = null;
  const clients: Client[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-events-keys-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    vi.useRealTimers();
    for (const client of clients.splice(0)) client.terminate();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    await db.execute(sql`TRUNCATE TABLE board_api_keys, agent_api_keys, company_memberships, agents, companies, "user" CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `user-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Socket Co", issuePrefix: `S${randomUUID().slice(0, 4).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const agentKey = async (scopeConfig: Record<string, unknown> | null) => {
      const token = `pcp_agent_${randomUUID()}`;
      const [row] = await db.insert(agentApiKeys).values({ agentId, companyId, name: "k", keyHash: hash(token), responsibleUserId: userId, scopeConfig: scopeConfig as never }).returning();
      return { id: row!.id, token };
    };
    const boardKey = async () => {
      const token = `pcp_board_${randomUUID()}`;
      const [row] = await db.insert(boardApiKeys).values({ userId, name: "b", keyHash: hash(token), expiresAt: new Date(Date.now() + 3_600_000) }).returning();
      return { id: row!.id, token };
    };
    return { companyId, agentKey, boardKey };
  }

  async function listen() {
    server = createServer();
    setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated", resolveSessionFromHeaders: async () => null });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    return (server.address() as AddressInfo).port;
  }

  /** "open", or the HTTP status the upgrade was refused with. */
  function connect(port: number, companyId: string, auth: { header?: string; query?: string }) {
    const url = `ws://127.0.0.1:${port}/api/companies/${companyId}/events/ws${auth.query ? `?token=${auth.query}` : ""}`;
    const client = new WebSocket(url, auth.header ? { headers: { authorization: `Bearer ${auth.header}` } } : {});
    clients.push(client);
    const closed = new Promise<number>((resolve) => client.on("close", (code) => resolve(code)));
    const outcome = new Promise<"open" | number>((resolve) => {
      client.on("open", () => resolve("open"));
      client.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      client.on("error", () => resolve(-1));
    });
    return { client, outcome, closed };
  }

  it("refuses an own-issues key, by header or query, and a key whose scope it cannot read; takes a standard key", async () => {
    const { companyId, agentKey } = await seed();
    const standard = await agentKey(null);
    const ownIssues = await agentKey({ kind: "own_issues", deniedLabelPrefixes: ["skill:"] });
    const unreadable = await agentKey({ kind: "own_issues", deniedLabelPrefixes: ["skill:"], allowedProjectIds: [] });
    const port = await listen();

    expect(await connect(port, companyId, { header: standard.token }).outcome).toBe("open");
    expect(await connect(port, companyId, { header: ownIssues.token }).outcome).toBe(403);
    expect(await connect(port, companyId, { query: ownIssues.token }).outcome).toBe(403);
    expect(await connect(port, companyId, { header: unreadable.token }).outcome).toBe(403);
  });

  it("closes a socket whose agent or board key is revoked, or whose board key expires, at the next ping", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { companyId, agentKey, boardKey } = await seed();
    const keptAgent = await agentKey(null);
    const revokedAgent = await agentKey(null);
    const keptBoard = await boardKey();
    const revokedBoard = await boardKey();
    const expiredBoard = await boardKey();
    const port = await listen();

    const sockets = {
      keptAgent: connect(port, companyId, { header: keptAgent.token }),
      revokedAgent: connect(port, companyId, { header: revokedAgent.token }),
      keptBoard: connect(port, companyId, { header: keptBoard.token }),
      revokedBoard: connect(port, companyId, { header: revokedBoard.token }),
      expiredBoard: connect(port, companyId, { header: expiredBoard.token }),
    };
    for (const [name, socket] of Object.entries(sockets)) expect(await socket.outcome, name).toBe("open");

    await db.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.id, revokedAgent.id));
    await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, revokedBoard.id));
    await db.update(boardApiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(boardApiKeys.id, expiredBoard.id));

    vi.advanceTimersByTime(30_000);
    const timeout = (ms: number) => new Promise<"still open">((resolve) => setTimeout(() => resolve("still open"), ms));
    expect(await Promise.race([sockets.revokedAgent.closed, timeout(5000)])).toBe(1008);
    expect(await Promise.race([sockets.revokedBoard.closed, timeout(5000)])).toBe(1008);
    expect(await Promise.race([sockets.expiredBoard.closed, timeout(5000)])).toBe(1008);
    expect(await Promise.race([sockets.keptAgent.closed, timeout(300)])).toBe("still open");
    expect(await Promise.race([sockets.keptBoard.closed, timeout(300)])).toBe("still open");
    expect(sockets.keptAgent.client.readyState).toBe(WebSocket.OPEN);
    expect(sockets.keptBoard.client.readyState).toBe(WebSocket.OPEN);
  }, 30_000);
});
