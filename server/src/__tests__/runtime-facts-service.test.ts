import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, runtimeFacts } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { normalizeRuntimeFactLimit, runtimeFactService, sameJson } from "../services/runtime-facts.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres runtime fact service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("runtime fact helpers", () => {
  it("compares JSON without regard to key order, and with regard to array order", () => {
    expect(sameJson({ a: 1, b: { c: [1, 2], d: null } }, { b: { d: null, c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson({ a: null }, { a: {} })).toBe(false);
    expect(sameJson([], {})).toBe(false);
    expect(sameJson("x", "x")).toBe(true);
  });

  it("bounds the list limit", () => {
    expect(normalizeRuntimeFactLimit(undefined)).toBe(200);
    expect(normalizeRuntimeFactLimit("0")).toBe(200);
    expect(normalizeRuntimeFactLimit("17")).toBe(17);
    expect(normalizeRuntimeFactLimit("999999")).toBe(1000);
    expect(normalizeRuntimeFactLimit("abc")).toBe(200);
  });
});

describeEmbeddedPostgres("runtime fact service list paging", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  // Several kinds, keys shared across kinds, and keys whose order depends on
  // collation: the cursor must follow the database's own (kind, key) order.
  const seeded = [
    ...["hermes", "openclaw", "metabolic"].map((key) => ({ kind: "runtime", key })),
    ...["a", "a b", "a-b", "a_b", "B", "b", "hermes", "z/1", "z/10", "z/2"].map((key) => ({ kind: "model_slot", key })),
    ...["job-1", "job-2", "hermes"].map((key) => ({ kind: "cron_job", key })),
  ];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-facts-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(runtimeFacts);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    await db.insert(companies).values(
      [companyId, otherCompanyId].map((id, index) => ({
        id,
        name: index === 0 ? "Paperclip" : "Other",
        issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      })),
    );
    await db.insert(runtimeFacts).values(seeded.map(({ kind, key }) => ({ companyId, kind, key, data: { key } })));
    await db.insert(runtimeFacts).values(seeded.map(({ kind, key }) => ({ companyId: otherCompanyId, kind, key, data: {} })));
  }

  async function pageThrough(opts: { kind?: string; limit: number }) {
    const svc = runtimeFactService(db);
    const seen: string[] = [];
    let after: { kind: string; key: string } | undefined;
    for (let pages = 0; pages < 100; pages += 1) {
      const page = await svc.list(companyId, { ...opts, after });
      expect(page.length).toBeLessThanOrEqual(opts.limit);
      expect(page.every((row) => row.companyId === companyId)).toBe(true);
      seen.push(...page.map((row) => `${row.kind}\u0000${row.key}`));
      if (page.length < opts.limit) return seen;
      const last = page[page.length - 1]!;
      after = { kind: last.kind, key: last.key };
    }
    throw new Error("paging did not finish");
  }

  it("pages through more than one page, returning every row exactly once in (kind, key) order", async () => {
    await seed();
    const svc = runtimeFactService(db);
    const all = (await svc.list(companyId, { limit: 1000 })).map((row) => `${row.kind}\u0000${row.key}`);
    expect(all).toHaveLength(seeded.length);
    expect(new Set(all)).toEqual(new Set(seeded.map(({ kind, key }) => `${kind}\u0000${key}`)));

    for (const limit of [1, 3, 4, seeded.length - 1, seeded.length]) {
      const paged = await pageThrough({ limit });
      expect(paged).toEqual(all);
    }
  });

  it("keeps the kind filter while paging", async () => {
    await seed();
    const svc = runtimeFactService(db);
    const modelSlots = (await svc.list(companyId, { kind: "model_slot", limit: 1000 })).map((row) => `${row.kind}\u0000${row.key}`);
    expect(modelSlots).toHaveLength(10);
    expect(await pageThrough({ kind: "model_slot", limit: 3 })).toEqual(modelSlots);
  });

  it("returns nothing for a cursor at or past the last row", async () => {
    await seed();
    const svc = runtimeFactService(db);
    const all = await svc.list(companyId, { limit: 1000 });
    const last = all[all.length - 1]!;
    expect(await svc.list(companyId, { after: { kind: last.kind, key: last.key } })).toEqual([]);
    expect(await svc.list(companyId, { after: { kind: "zzzz", key: "x" } })).toEqual([]);
    expect(await svc.list(companyId, { kind: "cron_job", after: { kind: "runtime", key: "a" } })).toEqual([]);
  });
});
