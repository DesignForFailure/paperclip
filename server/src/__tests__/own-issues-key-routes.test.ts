import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueLabels,
  issueWatchdogs,
  issues,
  labels,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { ownIssuesKeyGuard } from "../middleware/own-issues-key-guard.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

/**
 * An own-issues key (the fork's, for the commands an agent runs on its own) at the issue routes, against a real
 * database and the real authorization service: it reads, comments on and changes only its agent's own issues without
 * a denied label, and a task-watchdog run of its agent widens none of that.
 */

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "ok" })),
    })),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe.sequential : describe.skip;

const OWN_ISSUES = { kind: "own_issues", deniedLabelPrefixes: ["skill:"] } as const;

describePostgres("own-issues key at the issue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-own-issues-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    // As app.ts mounts them: the guard, then the routes.
    app.use("/api", ownIssuesKeyGuard());
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Own Issues Co",
      issuePrefix: `O${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner-1", status: "active", membershipRole: "owner" });
    const agent = async (name: string) => {
      const id = randomUUID();
      await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
      return id;
    };
    const ownAgentId = await agent("Own");
    const otherAgentId = await agent("Other");
    const issue = async (title: string, values: Partial<typeof issues.$inferInsert> = {}) => {
      const id = randomUUID();
      await db.insert(issues).values({
        id,
        companyId,
        title,
        status: "todo",
        priority: "medium",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        ...values,
      });
      return id;
    };
    const run = async (agentId: string, contextSnapshot: Record<string, unknown>) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "running", contextSnapshot });
      return id;
    };
    return { companyId, ownAgentId, otherAgentId, issue, run };
  }

  function agentActor(companyId: string, agentId: string, runId: string, keyScope?: Record<string, unknown>) {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_key",
      keyId: randomUUID(),
      ...(keyScope ? { keyScope } : {}),
    };
  }

  it("changes and comments on its agent's own ungated issue, never another agent's or a gated one", async () => {
    const { companyId, ownAgentId, otherAgentId, issue, run } = await seed();
    const own = await issue("Own", { assigneeAgentId: ownAgentId });
    const ownGated = await issue("Own gated", { assigneeAgentId: ownAgentId });
    const others = await issue("Other's", { assigneeAgentId: otherAgentId });
    const [label] = await db.insert(labels).values({ companyId, name: "skill:demo", color: "#7b8794" }).returning();
    await db.insert(issueLabels).values({ issueId: ownGated, labelId: label!.id, companyId });
    const runId = await run(ownAgentId, { issueId: own });
    const app = createApp(agentActor(companyId, ownAgentId, runId, OWN_ISSUES));

    const patchOwn = await request(app).patch(`/api/issues/${own}`).send({ title: "Own, renamed" });
    expect(patchOwn.status, JSON.stringify(patchOwn.body)).toBe(200);
    const commentOwn = await request(app).post(`/api/issues/${own}/comments`).send({ body: "On my own issue" });
    expect(commentOwn.status, JSON.stringify(commentOwn.body)).toBe(201);

    for (const [name, id] of [["another agent's", others], ["a gated", ownGated]] as const) {
      const patch = await request(app).patch(`/api/issues/${id}`).send({ title: "Not mine to rename" });
      expect(patch.status, `${name} PATCH: ${JSON.stringify(patch.body)}`).toBe(403);
      const comment = await request(app).post(`/api/issues/${id}/comments`).send({ body: "Not mine to comment on" });
      expect(comment.status, `${name} comment: ${JSON.stringify(comment.body)}`).toBe(403);
    }
    const titles = await db.select({ id: issues.id, title: issues.title }).from(issues).where(eq(issues.companyId, companyId));
    expect(titles.find((row) => row.id === others)?.title).toBe("Other's");
    expect(titles.find((row) => row.id === ownGated)?.title).toBe("Own gated");
  });

  it("gets no task-watchdog grant from a watchdog run of its agent", async () => {
    const { companyId, ownAgentId, otherAgentId, issue, run } = await seed();
    const watched = await issue("Watched", { assigneeAgentId: otherAgentId });
    const watchdogIssue = await issue("Watchdog report", {
      assigneeAgentId: ownAgentId,
      parentId: watched,
      originKind: "task_watchdog",
      originId: watched,
    });
    await db.insert(issueWatchdogs).values({
      companyId,
      issueId: watched,
      watchdogAgentId: ownAgentId,
      watchdogIssueId: watchdogIssue,
      status: "active",
    });
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId });
    const [watchdog] = await db
      .select({ lastObservedFingerprint: issueWatchdogs.lastObservedFingerprint })
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, watched)));
    const runId = await run(ownAgentId, {
      issueId: watchdogIssue,
      taskWatchdog: { watchedIssueId: watched, stopFingerprint: watchdog?.lastObservedFingerprint },
    });

    // The agent's standard key, in its watchdog run, may comment on the watched issue: the grant is there.
    const standard = createApp(agentActor(companyId, ownAgentId, runId));
    const granted = await request(standard).post(`/api/issues/${watched}/comments`).send({ body: "Watchdog finding" });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);

    // Its own-issues key, in the same run, may not: the scope only narrows.
    const scoped = createApp(agentActor(companyId, ownAgentId, runId, OWN_ISSUES));
    const comment = await request(scoped).post(`/api/issues/${watched}/comments`).send({ body: "Through the commands key" });
    expect(comment.status, JSON.stringify(comment.body)).toBe(403);
    const patch = await request(scoped).patch(`/api/issues/${watched}`).send({ title: "Renamed through the commands key" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(403);
    const [row] = await db.select({ title: issues.title }).from(issues).where(eq(issues.id, watched));
    expect(row?.title).toBe("Watched");
  });
});
