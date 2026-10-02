import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
  cancel: vi.fn(),
  reject: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ listIssuesForApproval: vi.fn(), linkManyForApproval: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { errorHandler } = await import("../middleware/index.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  return { errorHandler, approvalRoutes };
});

function createApp(actor: Record<string, unknown>) {
  const { errorHandler, approvalRoutes } = routeModules.value;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const board = { type: "board", userId: "user-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false };
const agent = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "api_key", isInstanceAdmin: false };
const pending = {
  id: "approval-1",
  companyId: "company-1",
  type: "request_board_approval",
  status: "pending",
  payload: { title: "Run a command" },
  requestedByAgentId: null,
  decisionNote: null,
};

describe("POST /approvals/:id/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.getById.mockReset();
    mockApprovalService.cancel.mockReset();
  });

  it("withdraws an open approval, logs it, wakes nobody and runs no rejection side effect", async () => {
    mockApprovalService.getById.mockResolvedValue(pending);
    mockApprovalService.cancel.mockResolvedValue({ ...pending, status: "cancelled", decisionNote: "Settled in the runtime" });

    const res = await request(createApp(board)).post("/api/approvals/approval-1/cancel").send({ decisionNote: "Settled in the runtime" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "approval-1", status: "cancelled", decisionNote: "Settled in the runtime" });
    expect(mockApprovalService.cancel).toHaveBeenCalledWith("approval-1", "Settled in the runtime");
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action: "approval.cancelled",
      entityType: "approval",
      entityId: "approval-1",
    });
  });

  it("is idempotent: an already-resolved approval is returned unchanged and nothing is logged", async () => {
    const approved = { ...pending, status: "approved" };
    mockApprovalService.getById.mockResolvedValue(approved);
    mockApprovalService.cancel.mockResolvedValue(null);

    const res = await request(createApp(board)).post("/api/approvals/approval-1/cancel").send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "approval-1", status: "approved" });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("is board-only", async () => {
    mockApprovalService.getById.mockResolvedValue(pending);
    const res = await request(createApp(agent)).post("/api/approvals/approval-1/cancel").send({});
    expect(res.status).toBe(403);
    expect(mockApprovalService.cancel).not.toHaveBeenCalled();
  });

  it("answers 404 for an approval of another company or an unknown one", async () => {
    mockApprovalService.getById.mockResolvedValue({ ...pending, companyId: "company-2" });
    expect((await request(createApp(board)).post("/api/approvals/approval-1/cancel").send({})).status).toBe(404);
    mockApprovalService.getById.mockResolvedValue(null);
    expect((await request(createApp(board)).post("/api/approvals/approval-1/cancel").send({})).status).toBe(404);
    expect(mockApprovalService.cancel).not.toHaveBeenCalled();
  });
});
