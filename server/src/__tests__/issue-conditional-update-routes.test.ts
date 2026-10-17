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
import { sameIssueVersion } from "../services/issue-conditional-update.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

/**
 * A conditional issue update (PATCH /issues/:id `expectedUpdatedAt`) against a real database: it applies only while the
 * issue still has the `updatedAt` the client read, else 409 `issue_changed` with the current issue and nothing
 * written; the version is compared at the millisecond precision the API gives, and every update is a version of its own.
 */

/** Runs once, the next time the route looks up a heartbeat run: another write landing in the middle of a PATCH. */
const hooks = vi.hoisted(() => ({ beforeGetRun: null as null | (() => Promise<void>) }));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
      const heartbeat = actual.heartbeatService(...args);
      return {
        ...heartbeat,
        getRun: async (runId: string) => {
          const hook = hooks.beforeGetRun;
          hooks.beforeGetRun = null;
          if (hook) await hook();
          return heartbeat.getRun(runId);
        },
      };
    },
  };
});

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
    hooks.beforeGetRun = null;
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
    // Stamped at insert, as the column default now() does: an update could not move updated_at back (0286's trigger).
    const { issueId, pinned, app } = await seed({ updatedAt: sql`'2026-10-16 12:00:00.123789+00'::timestamptz` as unknown as Date });
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

  it("moves a direct write of the row (not through the issue service) made in the version's own millisecond past it", async () => {
    // The wake queue takes an issue's execution lock with `updatedAt: input.now` (modules/wake-queue/adapters/postgres.ts:483-490),
    // and run dispatch clears it the same way (run-dispatch/adapters/postgres.ts:703-711); here that `now` is the
    // millisecond of the version a client read.
    const { issueId, pinned, working, app } = await seed();
    await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned] });
    const read = await request(app).get(`/api/issues/${issueId}`);
    const version = Date.parse(read.body.updatedAt);
    await db
      .update(issues)
      .set({ executionAgentNameKey: "worker", executionLockedAt: new Date(version), updatedAt: new Date(version) })
      .where(eq(issues.id, issueId));
    expect((await rowOf(issueId)).updatedAt.getTime()).toBe(version + 1);
    // So is a raw write that names a time behind the row's (a clock stepped back).
    await db.execute(sql`UPDATE issues SET updated_at = updated_at - interval '1 hour' WHERE id = ${issueId}`);
    expect((await rowOf(issueId)).updatedAt.getTime()).toBe(version + 2);
    // A write that changes nothing in the row is no new version (an import's "never backwards" recency bump).
    await db.execute(sql`UPDATE issues SET updated_at = greatest(updated_at, '2026-01-01T00:00:00Z'::timestamptz) WHERE id = ${issueId}`);
    expect((await rowOf(issueId)).updatedAt.getTime()).toBe(version + 2);
    // A write in the row's exact millisecond that changes another column is one.
    await db.update(issues).set({ priority: "low", updatedAt: new Date(version + 2) }).where(eq(issues.id, issueId));
    expect((await rowOf(issueId)).updatedAt.getTime()).toBe(version + 3);
    const stale = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [working], expectedUpdatedAt: read.body.updatedAt });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(await labelIdsOf(issueId)).toEqual([pinned]);
    // A write that does not set updated_at leaves it as it is.
    await db.update(issues).set({ priority: "high" }).where(eq(issues.id, issueId));
    expect((await rowOf(issueId)).updatedAt.getTime()).toBe(version + 3);
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

  it("moves the version of every issue a deleted label is taken off, so an update made on the old label set is refused", async () => {
    const { companyId, issueId, pinned, working, app } = await seed();
    const otherId = randomUUID();
    await db.insert(issues).values({ id: otherId, companyId, title: "Other card", status: "todo", priority: "medium" });
    await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [pinned, working] });
    const read = await request(app).get(`/api/issues/${issueId}`);
    const untouched = (await rowOf(otherId)).updatedAt.getTime();
    const removed = await request(app).delete(`/api/labels/${working}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(Date.parse((await request(app).get(`/api/issues/${issueId}`)).body.updatedAt)).toBeGreaterThan(Date.parse(read.body.updatedAt));
    expect((await rowOf(otherId)).updatedAt.getTime()).toBe(untouched);
    // The writer read [pinned, working] and drops pinned: refused as a change it did not see, not a 422 or a write.
    const stale = await request(app).patch(`/api/issues/${issueId}`).send({ labelIds: [working], expectedUpdatedAt: read.body.updatedAt });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.details.issue.labelIds).toEqual([pinned]);
    expect(await labelIdsOf(issueId)).toEqual([pinned]);
  });

  it("checks again right before its first side effect: a write that lands after the route's first check cancels no run", async () => {
    const { companyId, issueId, app } = await seed();
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "running", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ assigneeAgentId: agentId, status: "in_progress", executionRunId: runId }).where(eq(issues.id, issueId));
    const read = await request(app).get(`/api/issues/${issueId}`);
    // The route's first check passes; then, while it looks up the run to interrupt, another write lands.
    hooks.beforeGetRun = async () => {
      await issueService(db).update(issueId, { title: "Renamed meanwhile" });
    };
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "Stop that", interrupt: true, expectedUpdatedAt: read.body.updatedAt });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.issue.title).toBe("Renamed meanwhile");
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
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
