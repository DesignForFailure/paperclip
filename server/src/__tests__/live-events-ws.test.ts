import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logger } from "../middleware/logger.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const boardAuth = vi.hoisted(() => ({
  findBoardApiKeyByToken: vi.fn(),
  resolveBoardAccess: vi.fn(),
  touchBoardApiKey: vi.fn(),
}));

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: () => boardAuth,
}));

/** A database whose agent-key lookup finds nothing: a token that is no board key is then refused. */
const noAgentKeys = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
};

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableDestroyed = false;
  endedChunks: string[] = [];
  destroyCalls = 0;

  end(chunk?: string) {
    if (chunk) this.endedChunks.push(chunk);
    this.writableEnded = true;
    this.writable = false;
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("finish");
      if (!this.destroyed) {
        this.emit("close");
      }
    });
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("close");
    return this;
  }

  emitSocketError(err: Error) {
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("error", err);
  }
}

function createUpgradeRequest(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: "/api/companies/company-1/events/ws",
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("setupLiveEventsWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not write a rejection response after the raw upgrade socket is already closed", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    socket.destroy();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyCalls).toBe(1);
  });

  it("handles raw upgrade socket errors during async authorization", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    expect(() => socket.emitSocketError(new Error("write EPIPE"))).not.toThrow();
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: "/api/companies/company-1/events/ws" }),
      "live websocket upgrade socket error",
    );
    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys and cleans up listeners after flushing a rejection response", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("finish")).toBe(0);
  });

  it("authorizes a cloud-proxied browser for a company in its membership scope", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    const socket = new FakeUpgradeSocket();
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => {
        // Stop before the ws handshake writes to the fake socket; the
        // assertion is that authorization passed without any rejection.
        socket.writable = false;
        return { userId: "cloud-user-1", companyIds: ["company-1", "company-2"] };
      },
    });

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("rejects a cloud actor for a company outside its membership scope", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => ({ userId: "cloud-user-1", companyIds: ["company-other"] }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    // A resolved cloud actor is authoritative; the session path must not run.
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("falls through to session auth when no cloud actor resolves", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => null,
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(1);
    expect(socket.endedChunks[0]).toContain("403 Forbidden");
  });

  describe("board API keys", () => {
    const bearer = (token: string) => createUpgradeRequest({ headers: { authorization: `Bearer ${token}` } });

    async function upgrade(req: IncomingMessage, socket: FakeUpgradeSocket, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
      const server = new EventEmitter();
      const resolveSessionFromHeaders = vi.fn(async () => null);
      setupLiveEventsWebSocketServer(server as never, noAgentKeys as never, { deploymentMode, resolveSessionFromHeaders });
      server.emit("upgrade", req, socket as unknown as Duplex, Buffer.alloc(0));
      await flushPromises();
      await flushPromises();
      return { resolveSessionFromHeaders };
    }

    function grant(access: { user: boolean; isInstanceAdmin: boolean; companyIds: string[] }, socket: FakeUpgradeSocket) {
      boardAuth.findBoardApiKeyByToken.mockResolvedValue({ id: "key-1", userId: "user-1" });
      boardAuth.resolveBoardAccess.mockImplementation(async () => {
        // Stop before the ws handshake writes to the fake socket; a pass is the absence of a rejection.
        socket.writable = false;
        return { user: access.user ? { id: "user-1" } : null, isInstanceAdmin: access.isInstanceAdmin, companyIds: access.companyIds, memberships: [] };
      });
    }

    it("authorizes an instance admin's board key for any company, without a session", async () => {
      const socket = new FakeUpgradeSocket();
      grant({ user: true, isInstanceAdmin: true, companyIds: [] }, socket);
      const { resolveSessionFromHeaders } = await upgrade(bearer("pcp_board_admin"), socket);

      expect(socket.endedChunks).toEqual([]);
      expect(boardAuth.findBoardApiKeyByToken).toHaveBeenCalledWith("pcp_board_admin");
      expect(boardAuth.resolveBoardAccess).toHaveBeenCalledWith("user-1");
      expect(boardAuth.touchBoardApiKey).toHaveBeenCalledWith("key-1");
      expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
    });

    it("authorizes a member's board key for a company it belongs to", async () => {
      const socket = new FakeUpgradeSocket();
      grant({ user: true, isInstanceAdmin: false, companyIds: ["company-1"] }, socket);
      await upgrade(bearer("pcp_board_member"), socket);

      expect(socket.endedChunks).toEqual([]);
    });

    it("rejects a board key for a company its user is not a member of", async () => {
      const socket = new FakeUpgradeSocket();
      grant({ user: true, isInstanceAdmin: false, companyIds: ["company-other"] }, socket);
      socket.writable = true;
      boardAuth.resolveBoardAccess.mockResolvedValue({ user: { id: "user-1" }, isInstanceAdmin: false, companyIds: ["company-other"], memberships: [] });
      await upgrade(bearer("pcp_board_outsider"), socket);

      expect(socket.endedChunks[0]).toContain("403 Forbidden");
      expect(boardAuth.touchBoardApiKey).not.toHaveBeenCalled();
    });

    it("rejects a board key whose user is gone", async () => {
      const socket = new FakeUpgradeSocket();
      boardAuth.findBoardApiKeyByToken.mockResolvedValue({ id: "key-1", userId: "user-gone" });
      boardAuth.resolveBoardAccess.mockResolvedValue({ user: null, isInstanceAdmin: false, companyIds: [], memberships: [] });
      await upgrade(bearer("pcp_board_orphan"), socket);

      expect(socket.endedChunks[0]).toContain("403 Forbidden");
      expect(boardAuth.touchBoardApiKey).not.toHaveBeenCalled();
    });

    it("rejects a token that is neither a board key nor an agent key", async () => {
      const socket = new FakeUpgradeSocket();
      boardAuth.findBoardApiKeyByToken.mockResolvedValue(null);
      await upgrade(bearer("pcp_board_unknown"), socket);

      expect(socket.endedChunks[0]).toContain("403 Forbidden");
      expect(boardAuth.resolveBoardAccess).not.toHaveBeenCalled();
    });

    it("never takes a board key from the query string, where it would be logged", async () => {
      const socket = new FakeUpgradeSocket();
      grant({ user: true, isInstanceAdmin: true, companyIds: [] }, socket);
      socket.writable = true;
      boardAuth.resolveBoardAccess.mockResolvedValue({ user: { id: "user-1" }, isInstanceAdmin: true, companyIds: [], memberships: [] });
      await upgrade(createUpgradeRequest({ url: "/api/companies/company-1/events/ws?token=pcp_board_admin" }), socket);

      expect(boardAuth.findBoardApiKeyByToken).not.toHaveBeenCalled();
      expect(socket.endedChunks[0]).toContain("403 Forbidden");
    });

    it("authorizes a board key under local_trusted as well, as the HTTP routes do", async () => {
      const socket = new FakeUpgradeSocket();
      grant({ user: true, isInstanceAdmin: true, companyIds: [] }, socket);
      await upgrade(bearer("pcp_board_admin"), socket, "local_trusted");

      expect(socket.endedChunks).toEqual([]);
      expect(boardAuth.findBoardApiKeyByToken).toHaveBeenCalledWith("pcp_board_admin");
    });
  });
});
