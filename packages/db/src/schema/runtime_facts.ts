import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Company-scoped facts about the runtimes that execute agents, reported by an
 * external observer: which runtimes are reachable, which model slots exist,
 * which runtime-native schedules exist and how their runs ended. One row per
 * (company, kind, key); `data` is the reporter's JSON for that fact.
 *
 * These are not issues and not agents: before this table a reporter could only
 * hide such state inside issue objects or the append-only activity log.
 */
export const runtimeFacts = pgTable(
  "runtime_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    /** When the reporter last saw the fact (it may re-report unchanged data). */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When `data` last changed. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKindKeyIdx: uniqueIndex("runtime_facts_company_kind_key_idx").on(table.companyId, table.kind, table.key),
    companyKindObservedIdx: index("runtime_facts_company_kind_observed_idx").on(table.companyId, table.kind, table.observedAt),
  }),
);
