import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issueLabels, issues, labels } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { nextIssueUpdatedAt, sameIssueVersion } from "../services/issue-conditional-update.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

/**
 * A conditional issue update (PATCH /issues/:id `expectedUpdatedAt`) against a real database: it applies only while the
 * issue still has the `updatedAt` the client read, else 409 `issue_changed` with the current issue and nothing
 * written; the version is compared at the millisecond precision the API gives, and every update is a version of its own.
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

describe("issue versions", () => {
  it("are the same version at millisecond precision, whatever the microseconds", () => {
    // Postgres keeps microseconds; the driver's Date and JSON keep milliseconds, truncated.
    const stored = new Date("2026-10-16 12:00:00.123999+00");
    expect(sameIssueVersion(stored, new Date("2026-10-16T12:00:00.123Z"))).toBe(true);
    expect(sameIssueVersion(stored, new Date("2026-10-16T12:00:00.124Z"))).toBe(false);
    expect(sameIssueVersion(stored, new Date("2026-10-16T12:00:00.122Z"))).toBe(false);
  });

  it("move on by at least a millisecond with every update, even when the clock does not", () => {
    const previous = new Date("2026-10-16T12:00:00.123Z");
    expect(nextIssueUpdatedAt(new Date("2026-10-16T12:00:05.000Z"), previous).toISOString()).toBe("2026-10-16T12:00:05.000Z");
    expect(nextIssueUpdatedAt(new Date(previous), previous).toISOString()).toBe("2026-10-16T12:00:00.124Z");
    expect(nextIssueUpdatedAt(new Date("2026-10-16T11:59:00.000Z"), previous).toISOString()).toBe("2026-10-16T12:00:00.124Z");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe.sequential : describe.skip;

describePostgres("conditional issue PATCH", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-conditional-update-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  async function seed(values: Partial<typeof issues.$inferInsert> = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Conditional Co",
      issuePrefix: `C${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", status: "active", membershipRole: "owner" });
    const label = async (name: string) =>
      (await db.insert(labels).values({ companyId, name, color: "#7b8794" }).returning())[0]!.id;
    const [pinned, working] = [await label("board:pinned"), await label("board:working")];
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Card", status: "todo", priority: "medium", ...values });
    return { companyId, issueId, pinned, working, app: createApp(companyId) };
  }

  const labelIdsOf = async (issueId: string) =>
    (await db.select({ labelId: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, issueId))).map((r) => r.labelId).sort();
  const rowOf = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;

  it("applies an update that names the updatedAt the client read", async () => {
    const { issueId, pinned, app } = await seed();
    const read = await request(app).get(`/api/issues/${issueId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const res = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned], expectedUpdatedAt: read.body.updatedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.labelIds).toEqual([pinned]);
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThan(Date.parse(read.body.updatedAt));
  });

  it("answers 409 issue_changed with the current issue when the issue changed since, and writes nothing", async () => {
    const { issueId, pinned, working, app } = await seed();
    const read = await request(app).get(`/api/issues/${issueId}`);
    // Another writer (the board's Pin) lands after the read.
    const pin = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned] });
    expect(pin.status, JSON.stringify(pin.body)).toBe(200);
    // The stale writer would replace the whole set, dropping the pin.
    const res = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [working], status: "in_review", expectedUpdatedAt: read.body.updatedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      code: "issue_changed",
      details: { code: "issue_changed", expectedUpdatedAt: read.body.updatedAt, updatedAt: pin.body.updatedAt },
    });
    expect(res.body.details.issue).toMatchObject({ id: issueId, status: "todo", labelIds: [pinned], updatedAt: pin.body.updatedAt });
    expect(await labelIdsOf(issueId)).toEqual([pinned]);
    expect((await rowOf(issueId)).status).toBe("todo");
    // Read again, the writer applies its own change on top of the pin.
    const again = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned, working], expectedUpdatedAt: res.body.details.updatedAt });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await labelIdsOf(issueId)).toEqual([pinned, working].sort());
  });

  it("matches a row Postgres stamped in microseconds by the milliseconds the API gave, and no other", async () => {
    const { issueId, pinned, app } = await seed();
    await db.execute(sql`UPDATE issues SET updated_at = '2026-10-16 12:00:00.123789+00' WHERE id = ${issueId}`);
    const read = await request(app).get(`/api/issues/${issueId}`);
    expect(read.body.updatedAt).toBe("2026-10-16T12:00:00.123Z");
    for (const off of ["2026-10-16T12:00:00.122Z", "2026-10-16T12:00:00.124Z", "2026-10-16T12:00:00.000Z"]) {
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned], expectedUpdatedAt: off });
      expect(res.status, `${off}: ${JSON.stringify(res.body)}`).toBe(409);
    }
    expect(await labelIdsOf(issueId)).toEqual([]);
    const res = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned], expectedUpdatedAt: read.body.updatedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("gives every update a version of its own: an update in the row's millisecond moves it on, so a stale client still fails", async () => {
    const { issueId, pinned, working, app } = await seed();
    // The row's updatedAt is ahead of the clock (a clock stepped back, or two writes in one millisecond).
    const ahead = new Date(Date.now() + 60 * 60 * 1000);
    await db.update(issues).set({ updatedAt: ahead }).where(eq(issues.id, issueId));
    const read = await request(app).get(`/api/issues/${issueId}`);
    const pin = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned] });
    expect(pin.status, JSON.stringify(pin.body)).toBe(200);
    expect(Date.parse(pin.body.updatedAt)).toBe(ahead.getTime() + 1);
    const stale = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [working], expectedUpdatedAt: read.body.updatedAt });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(await labelIdsOf(issueId)).toEqual([pinned]);
  });

  it("applies one of two conditional updates of the same version, and answers the other 409", async () => {
    const { issueId, pinned, working, app } = await seed();
    const read = await request(app).get(`/api/issues/${issueId}`);
    const [a, b] = await Promise.all([
      request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned], expectedUpdatedAt: read.body.updatedAt }),
      request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [working], expectedUpdatedAt: read.body.updatedAt }),
    ]);
    expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([200, 409]);
    const winner = a.status === 200 ? pinned : working;
    expect(await labelIdsOf(issueId)).toEqual([winner]);
  });

  it("is unconditional without expectedUpdatedAt, as before", async () => {
    const { issueId, pinned, working, app } = await seed();
    await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned] });
    const res = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [working] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await labelIdsOf(issueId)).toEqual([working]);
  });

  it("refuses an expectedUpdatedAt that is not a UTC timestamp (400)", async () => {
    const { issueId, pinned, app } = await seed();
    const res = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned], expectedUpdatedAt: "yesterday" });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await labelIdsOf(issueId)).toEqual([]);
  });

  it("is checked again by the issue service under its row lock: a write after the route's check is 409", async () => {
    // The route's check ran before the other write; only the service's, under the lock, can see it.
    const { issueId, pinned, working } = await seed();
    const svc = issueService(db);
    const before = await rowOf(issueId);
    await svc.update(issueId, { labelIds: [pinned] });
    await expect(svc.update(issueId, { labelIds: [working], expectedUpdatedAt: before.updatedAt })).rejects.toMatchObject({
      status: 409,
      details: { code: "issue_changed" },
    });
    expect(await labelIdsOf(issueId)).toEqual([pinned]);
    const current = await rowOf(issueId);
    const updated = await svc.update(issueId, { labelIds: [pinned, working], expectedUpdatedAt: current.updatedAt });
    expect(updated?.labelIds.sort()).toEqual([pinned, working].sort());
  });

  it("refuses a stale update before its side effects: a board interrupt cancels no run", async () => {
    const { companyId, issueId, app } = await seed();
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "running", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ assigneeAgentId: agentId, status: "in_progress", executionRunId: runId }).where(eq(issues.id, issueId));
    const read = await request(app).get(`/api/issues/${issueId}`);
    await request(app).patch(`/api/issues/${issueId}`).send({ title: "Card, renamed" });
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "Stop that", interrupt: true, expectedUpdatedAt: read.body.updatedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
  });
});
