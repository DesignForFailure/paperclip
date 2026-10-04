import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { runtimeFacts } from "@paperclipai/db";
import { RUNTIME_FACT_LIST_DEFAULT_LIMIT, RUNTIME_FACT_LIST_MAX_LIMIT } from "@paperclipai/shared";

export type RuntimeFactRow = typeof runtimeFacts.$inferSelect;

export interface RuntimeFactUpsertResult {
  fact: RuntimeFactRow;
  /** created: no row existed. changed: `data` differs from the stored row. unchanged: only `observedAt` moved. */
  outcome: "created" | "changed" | "unchanged";
}

/** Order-insensitive JSON equality: jsonb does not keep key order, so a plain stringify compare would lie. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameJson(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

export function normalizeRuntimeFactLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return RUNTIME_FACT_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), RUNTIME_FACT_LIST_MAX_LIMIT);
}

/** Keyset cursor for the list: the (kind, key) of the last row of the previous page. */
export interface RuntimeFactListCursor {
  kind: string;
  key: string;
}

export function runtimeFactService(db: Db) {
  return {
    /**
     * A company's facts in (kind, key) order. With `after`, only rows whose
     * (kind, key) is strictly greater than the cursor: a row comparison, which
     * the unique (company_id, kind, key) index serves as a range scan.
     */
    list: (companyId: string, opts: { kind?: string; limit?: number; after?: RuntimeFactListCursor } = {}) =>
      db
        .select()
        .from(runtimeFacts)
        .where(
          and(
            eq(runtimeFacts.companyId, companyId),
            opts.kind ? eq(runtimeFacts.kind, opts.kind) : undefined,
            opts.after ? sql`(${runtimeFacts.kind}, ${runtimeFacts.key}) > (${opts.after.kind}, ${opts.after.key})` : undefined,
          ),
        )
        .orderBy(asc(runtimeFacts.kind), asc(runtimeFacts.key))
        .limit(opts.limit ?? RUNTIME_FACT_LIST_DEFAULT_LIMIT),

    get: (companyId: string, kind: string, key: string) =>
      db
        .select()
        .from(runtimeFacts)
        .where(and(eq(runtimeFacts.companyId, companyId), eq(runtimeFacts.kind, kind), eq(runtimeFacts.key, key)))
        .then((rows) => rows[0] ?? null),

    upsert: async (
      companyId: string,
      kind: string,
      key: string,
      input: { data: Record<string, unknown>; observedAt?: Date },
    ): Promise<RuntimeFactUpsertResult> =>
      db.transaction(async (tx) => {
        const observedAt = input.observedAt ?? new Date();
        // Insert first: the unique index settles a race between two reporters of the same fact.
        const inserted = await tx
          .insert(runtimeFacts)
          .values({ companyId, kind, key, data: input.data, observedAt })
          .onConflictDoNothing({ target: [runtimeFacts.companyId, runtimeFacts.kind, runtimeFacts.key] })
          .returning();
        if (inserted[0]) return { fact: inserted[0], outcome: "created" as const };

        const existing = await tx
          .select()
          .from(runtimeFacts)
          .where(and(eq(runtimeFacts.companyId, companyId), eq(runtimeFacts.kind, kind), eq(runtimeFacts.key, key)))
          .for("update")
          .then((rows) => rows[0]);
        if (!existing) throw new Error("runtime fact disappeared during upsert");
        const changed = !sameJson(existing.data, input.data);
        const updated = await tx
          .update(runtimeFacts)
          .set(changed ? { data: input.data, observedAt, updatedAt: new Date() } : { observedAt })
          .where(eq(runtimeFacts.id, existing.id))
          .returning()
          .then((rows) => rows[0]!);
        return { fact: updated, outcome: changed ? ("changed" as const) : ("unchanged" as const) };
      }),

    remove: (companyId: string, kind: string, key: string) =>
      db
        .delete(runtimeFacts)
        .where(and(eq(runtimeFacts.companyId, companyId), eq(runtimeFacts.kind, kind), eq(runtimeFacts.key, key)))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
