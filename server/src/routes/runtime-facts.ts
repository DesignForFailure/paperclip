import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { runtimeFactKeySchema, runtimeFactKindSchema, upsertRuntimeFactSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { badRequest } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { normalizeRuntimeFactLimit, runtimeFactService } from "../services/runtime-facts.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Company-scoped runtime facts (see packages/db/src/schema/runtime_facts.ts).
 * Reads need company access; writes are board-only. A write is logged, and so
 * announced on the company's live channel, only when the fact is created,
 * changes or is removed: a reporter that re-reports unchanged data every few
 * seconds must not grow the activity log.
 */
export function runtimeFactRoutes(db: Db) {
  const router = Router();
  const svc = runtimeFactService(db);

  function parseKindAndKey(params: Record<string, unknown>) {
    const kind = runtimeFactKindSchema.safeParse(params.kind);
    const key = runtimeFactKeySchema.safeParse(params.key);
    if (!kind.success) throw badRequest(kind.error.issues[0]?.message ?? "Invalid kind");
    if (!key.success) throw badRequest(key.error.issues[0]?.message ?? "Invalid key");
    return { kind: kind.data, key: key.data };
  }

  /**
   * The list's keyset cursor: `afterKind` and `afterKey` together, the (kind, key)
   * of the last row of the previous page, or neither. An empty value counts as
   * absent, as it does for `kind`.
   */
  function parseListCursor(query: Record<string, unknown>) {
    const given = (value: unknown) => value !== undefined && value !== "";
    if (!given(query.afterKind) && !given(query.afterKey)) return undefined;
    if (!given(query.afterKind) || !given(query.afterKey)) throw badRequest("afterKind and afterKey must be given together");
    if (typeof query.afterKind !== "string" || typeof query.afterKey !== "string") {
      throw badRequest("afterKind and afterKey must each be given once");
    }
    const kind = runtimeFactKindSchema.safeParse(query.afterKind);
    const key = runtimeFactKeySchema.safeParse(query.afterKey);
    if (!kind.success) throw badRequest(`afterKind: ${kind.error.issues[0]?.message ?? "invalid kind"}`);
    if (!key.success) throw badRequest(`afterKey: ${key.error.issues[0]?.message ?? "invalid key"}`);
    return { kind: kind.data, key: key.data };
  }

  router.get("/companies/:companyId/runtime-facts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    let kind: string | undefined;
    if (typeof req.query.kind === "string" && req.query.kind !== "") {
      const parsed = runtimeFactKindSchema.safeParse(req.query.kind);
      if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid kind");
      kind = parsed.data;
    }
    const after = parseListCursor(req.query);
    res.json(await svc.list(companyId, { kind, limit: normalizeRuntimeFactLimit(req.query.limit), after }));
  });

  router.put("/companies/:companyId/runtime-facts/:kind/:key", validate(upsertRuntimeFactSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { kind, key } = parseKindAndKey(req.params);
    const { fact, outcome } = await svc.upsert(companyId, kind, key, {
      data: req.body.data,
      observedAt: req.body.observedAt ? new Date(req.body.observedAt) : undefined,
    });
    if (outcome !== "unchanged") {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: outcome === "created" ? "runtime_fact.created" : "runtime_fact.updated",
        entityType: "runtime_fact",
        entityId: fact.id,
        details: { kind, key },
      });
    }
    res.status(outcome === "created" ? 201 : 200).json(fact);
  });

  router.delete("/companies/:companyId/runtime-facts/:kind/:key", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { kind, key } = parseKindAndKey(req.params);
    const removed = await svc.remove(companyId, kind, key);
    if (!removed) {
      res.status(404).json({ error: "Runtime fact not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "runtime_fact.deleted",
      entityType: "runtime_fact",
      entityId: removed.id,
      details: { kind, key },
    });
    res.json(removed);
  });

  return router;
}
