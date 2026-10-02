import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockRuntimeFactService = vi.hoisted(() => ({
  list: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/runtime-facts.js", async () => {
    const actual = await vi.importActual<typeof import("../services/runtime-facts.js")>("../services/runtime-facts.js");
    return { ...actual, runtimeFactService: () => mockRuntimeFactService };
  });
  vi.doMock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { errorHandler } = await import("../middleware/index.js");
  const { runtimeFactRoutes } = await import("../routes/runtime-facts.js");
  return { errorHandler, runtimeFactRoutes };
});

function createApp(actor: Record<string, unknown>) {
  const { errorHandler, runtimeFactRoutes } = routeModules.value;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", runtimeFactRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const board = { type: "board", userId: "user-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false };
const agent = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "api_key", isInstanceAdmin: false };
const fact = { id: "fact-1", companyId: "company-1", kind: "runtime", key: "hermes", data: { status: "up" } };

describe("runtime fact routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntimeFactService.list.mockReset();
    mockRuntimeFactService.upsert.mockReset();
    mockRuntimeFactService.remove.mockReset();
  });

  it("lists a company's facts, optionally by kind, with a bounded limit", async () => {
    mockRuntimeFactService.list.mockResolvedValue([fact]);
    const res = await request(createApp(agent)).get("/api/companies/company-1/runtime-facts?kind=runtime&limit=5000");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([fact]);
    expect(mockRuntimeFactService.list).toHaveBeenCalledWith("company-1", { kind: "runtime", limit: 1000 });
  });

  it("refuses another company's facts and a malformed kind", async () => {
    expect((await request(createApp(board)).get("/api/companies/company-2/runtime-facts")).status).toBe(403);
    expect((await request(createApp(board)).get("/api/companies/company-1/runtime-facts?kind=Bad-Kind")).status).toBe(400);
    expect(mockRuntimeFactService.list).not.toHaveBeenCalled();
  });

  it("creates a fact with 201 and logs it", async () => {
    mockRuntimeFactService.upsert.mockResolvedValue({ fact, outcome: "created" });
    const res = await request(createApp(board))
      .put("/api/companies/company-1/runtime-facts/runtime/hermes")
      .send({ data: { status: "up" }, observedAt: "2026-10-01T12:00:00.000Z" });
    expect(res.status).toBe(201);
    expect(mockRuntimeFactService.upsert).toHaveBeenCalledWith("company-1", "runtime", "hermes", {
      data: { status: "up" },
      observedAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      companyId: "company-1",
      action: "runtime_fact.created",
      entityType: "runtime_fact",
      entityId: "fact-1",
      details: { kind: "runtime", key: "hermes" },
    });
  });

  it("logs a change, and logs nothing when a reporter repeats unchanged data", async () => {
    mockRuntimeFactService.upsert.mockResolvedValueOnce({ fact, outcome: "changed" });
    expect((await request(createApp(board)).put("/api/companies/company-1/runtime-facts/runtime/hermes").send({ data: { status: "down" } })).status).toBe(200);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({ action: "runtime_fact.updated" });
    mockLogActivity.mockClear();
    mockRuntimeFactService.upsert.mockResolvedValueOnce({ fact, outcome: "unchanged" });
    expect((await request(createApp(board)).put("/api/companies/company-1/runtime-facts/runtime/hermes").send({ data: { status: "up" } })).status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("is board-only for writes and validates kind, body and size", async () => {
    expect((await request(createApp(agent)).put("/api/companies/company-1/runtime-facts/runtime/hermes").send({ data: {} })).status).toBe(403);
    expect((await request(createApp(agent)).delete("/api/companies/company-1/runtime-facts/runtime/hermes")).status).toBe(403);
    expect((await request(createApp(board)).put("/api/companies/company-1/runtime-facts/Runtime/hermes").send({ data: {} })).status).toBe(400);
    expect((await request(createApp(board)).put("/api/companies/company-1/runtime-facts/runtime/hermes").send({ data: "no" })).status).toBe(400);
    expect((await request(createApp(board)).put("/api/companies/company-1/runtime-facts/runtime/hermes").send({ data: { blob: "x".repeat(70_000) } })).status).toBe(400);
    expect(mockRuntimeFactService.upsert).not.toHaveBeenCalled();
    expect(mockRuntimeFactService.remove).not.toHaveBeenCalled();
  });

  it("deletes a fact and logs it; an unknown fact is 404", async () => {
    mockRuntimeFactService.remove.mockResolvedValueOnce(fact);
    expect((await request(createApp(board)).delete("/api/companies/company-1/runtime-facts/runtime/hermes")).status).toBe(200);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({ action: "runtime_fact.deleted", entityId: "fact-1" });
    mockRuntimeFactService.remove.mockResolvedValueOnce(null);
    expect((await request(createApp(board)).delete("/api/companies/company-1/runtime-facts/runtime/hermes")).status).toBe(404);
  });
});
