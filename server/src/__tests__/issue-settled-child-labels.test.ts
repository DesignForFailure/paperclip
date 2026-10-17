import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, issueLabels, issues, labels } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

/**
 * PAPERCLIP_SETTLED_CHILD_LABELS (a fork setting, for Continuum): a child issue that carries a label named in it counts
 * as settled when Paperclip decides whether closing a child wakes its parent's agent, as `done` and `cancelled` do.
 * Continuum keeps a finished sub-agent's issue `in_progress`, labelled `board:subagent-done` or `board:subagent-failed`,
 * until its parent is done, because closing the last open child wakes the parent's agent and its observer must never
 * wake an agent. Without this setting a person's own sub-issue of that parent could then never wake it. Real database,
 * the real issue service and route; the heartbeat only records the wakes it is asked for.
 */

const hooks = vi.hoisted(() => ({ wakes: [] as Array<{ agentId: string; reason?: string | null; payload?: Record<string, unknown> | null }> }));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: async (agentId: string, opts: { reason?: string | null; payload?: Record<string, unknown> | null } = {}) => {
        hooks.wakes.push({ agentId, reason: opts.reason, payload: opts.payload });
        return null;
      },
    }),
  };
});

const SETTING = "PAPERCLIP_SETTLED_CHILD_LABELS";
const CONTINUUM_LABELS = "board:subagent-done,board:subagent-failed";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe.sequential : describe.skip;

describePostgres("settled child labels", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-settled-child-labels-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    hooks.wakes = [];
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function company() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Settled Co",
      issuePrefix: `S${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", status: "active", membershipRole: "owner" });
    return companyId;
  }

  const label = async (companyId: string, name: string) =>
    (await db.insert(labels).values({ companyId, name, color: "#7b8794" }).returning())[0]!.id;

  /**
   * An executor's issue in Awaiting review (assigned to its agent) with two children: a sub-agent the run started
   * (`in_progress`, held as Continuum holds it) and the person's own sub-issue.
   */
  async function seed(input: { heldLabel?: string | null; personStatus?: "todo" | "done"; companyId?: string } = {}) {
    const companyId = input.companyId ?? (await company());
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: `Executor ${agentId.slice(0, 4)}`, role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const parentId = randomUUID();
    const heldId = randomUUID();
    const personId = randomUUID();
    await db.insert(issues).values({ id: parentId, companyId, title: "Executor issue", status: "in_review", priority: "medium", assigneeAgentId: agentId });
    // Distinct issue numbers: the service orders children by issueNumber, then createdAt (one insert shares createdAt).
    await db.insert(issues).values([
      { id: heldId, companyId, parentId, title: "Sub-agent", status: "in_progress", priority: "medium", assigneeUserId: "local-board", issueNumber: 1 },
      { id: personId, companyId, parentId, title: "Person's sub-issue", status: input.personStatus ?? "done", priority: "medium", assigneeUserId: "local-board", issueNumber: 2 },
    ]);
    if (input.heldLabel) {
      await db.insert(issueLabels).values({ issueId: heldId, labelId: await label(companyId, input.heldLabel), companyId });
    }
    return { companyId, agentId, parentId, heldId, personId };
  }

  function createApp(companyIds: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds, source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  describe("getWakeableParentAfterChildCompletion", () => {
    it.each(["board:subagent-done", "board:subagent-failed"])(
      "counts a child labelled %s as settled when the setting names it",
      async (heldLabel) => {
        vi.stubEnv(SETTING, " board:subagent-done , board:subagent-failed ,");
        const { agentId, parentId, heldId, personId } = await seed({ heldLabel });
        expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toMatchObject({
          id: parentId,
          assigneeAgentId: agentId,
          childIssueIds: [heldId, personId],
          childIssueSummaries: [
            expect.objectContaining({ id: heldId, status: "in_progress" }),
            expect.objectContaining({ id: personId, status: "done" }),
          ],
          childIssueSummaryTruncated: false,
        });
      },
    );

    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["only separators", " , ,"],
    ])("keeps upstream behaviour when the setting is %s: a labelled open child is not settled", async (_name, value) => {
      vi.stubEnv(SETTING, value);
      const { parentId } = await seed({ heldLabel: "board:subagent-done" });
      expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();
    });

    it("does not count an open child without a label (a sub-agent still running)", async () => {
      vi.stubEnv(SETTING, CONTINUUM_LABELS);
      const { parentId } = await seed({ heldLabel: null });
      expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();
    });

    it("does not count an open child whose label is not in the set", async () => {
      vi.stubEnv(SETTING, CONTINUUM_LABELS);
      const { parentId } = await seed({ heldLabel: "board:working" });
      expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();
    });

    it("matches a label's exact name", async () => {
      vi.stubEnv(SETTING, CONTINUUM_LABELS);
      const { parentId } = await seed({ heldLabel: "Board:Subagent-Done" });
      expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();
    });

    it("does not count a label of that name from another company", async () => {
      vi.stubEnv(SETTING, CONTINUUM_LABELS);
      const { companyId, parentId, heldId } = await seed({ heldLabel: null });
      const otherCompany = await company();
      // The schema does not tie a label to its issue's company, so the row can exist: written by hand here.
      await db.insert(issueLabels).values({ issueId: heldId, labelId: await label(otherCompany, "board:subagent-done"), companyId });
      expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();
    });

    it("still needs every open child settled: one labelled and one running is not enough", async () => {
      vi.stubEnv(SETTING, CONTINUUM_LABELS);
      const { companyId, parentId } = await seed({ heldLabel: "board:subagent-done" });
      await db.insert(issues).values({ companyId, parentId, title: "Second sub-agent", status: "in_progress", priority: "medium", issueNumber: 3 });
      expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();
    });
  });

  describe("PATCH /issues/:id", () => {
    it("wakes the parent's agent when a person closes their sub-issue beside a held sub-agent", async () => {
      vi.stubEnv(SETTING, CONTINUUM_LABELS);
      const { companyId, agentId, parentId, heldId, personId } = await seed({ heldLabel: "board:subagent-done", personStatus: "todo" });
      const res = await request(createApp([companyId])).patch(`/api/issues/${personId}`).send({ status: "done" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await vi.waitFor(() => {
        expect(hooks.wakes).toContainEqual({
          agentId,
          reason: "issue_children_completed",
          payload: expect.objectContaining({ issueId: parentId, completedChildIssueId: personId, childIssueIds: [heldId, personId] }),
        });
      });
    });

    it("queues no wake for a labels-only PATCH, even one that settles the last open child (the observer's write)", async () => {
      vi.stubEnv(SETTING, CONTINUUM_LABELS);
      // The person closed their sub-issue while the sub-agent was still running; the sub-agent then finishes.
      const { companyId, agentId, parentId, heldId } = await seed({ heldLabel: null, personStatus: "done" });
      const done = await label(companyId, "board:subagent-done");
      const app = createApp([companyId]);
      const res = await request(app).patch(`/api/issues/${heldId}`).send({ labelIds: [done] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // The parent now passes the check, so only the route's "a child's status became terminal" rule keeps it asleep.
      expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toMatchObject({ id: parentId });
      // A later wake, of another executor, comes after anything the first request's background step would queue.
      const other = await seed({ companyId, heldLabel: null, personStatus: "todo" });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, other.heldId));
      const close = await request(app).patch(`/api/issues/${other.personId}`).send({ status: "done" });
      expect(close.status, JSON.stringify(close.body)).toBe(200);
      await vi.waitFor(() => {
        expect(hooks.wakes.map((wake) => wake.agentId)).toContain(other.agentId);
      });
      expect(hooks.wakes.filter((wake) => wake.agentId === agentId)).toEqual([]);
    });
  });
});
