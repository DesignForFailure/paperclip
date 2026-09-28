import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { activityLog, type Db } from "@paperclipai/db";
import type { IssueReviewPolicy } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

export interface IssueReviewVerdictActor {
  type: "agent" | "user";
  id: string;
}

export interface IssueReviewRequester extends IssueReviewVerdictActor {
  reviewInteractionId: string | null;
}

interface ReviewPolicyIssue {
  id: string;
  companyId: string;
  reviewPolicy?: IssueReviewPolicy | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}

export async function resolveIssueReviewRequester(
  db: Db,
  issue: ReviewPolicyIssue,
): Promise<IssueReviewRequester | null> {
  const transition = await db
    .select({
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      details: activityLog.details,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id),
      eq(activityLog.action, "issue.updated"),
      sql`(
        (
          ${activityLog.details} ->> 'status' = 'in_review'
          AND ${activityLog.details} -> '_previous' ->> 'status' IS NOT NULL
          AND ${activityLog.details} -> '_previous' ->> 'status' <> 'in_review'
        )
        OR
        (
          ${activityLog.details} -> 'changes' -> 'status' ->> 'to' = 'in_review'
          AND ${activityLog.details} -> 'changes' -> 'status' ->> 'from' IS NOT NULL
          AND ${activityLog.details} -> 'changes' -> 'status' ->> 'from' <> 'in_review'
        )
      )`,
    ))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (transition?.actorType === "agent" || transition?.actorType === "user") {
    const reviewInteractionId = typeof transition.details?.reviewInteractionId === "string"
      ? transition.details.reviewInteractionId
      : null;
    return { type: transition.actorType, id: transition.actorId, reviewInteractionId };
  }
  if (issue.createdByAgentId && !issue.createdByUserId) {
    return { type: "agent", id: issue.createdByAgentId, reviewInteractionId: null };
  }
  if (issue.createdByUserId && !issue.createdByAgentId) {
    return { type: "user", id: issue.createdByUserId, reviewInteractionId: null };
  }
  return null;
}

export async function isIssueReviewVerdictInteraction(
  db: Db,
  input: {
    issue: ReviewPolicyIssue;
    interaction: {
      id: string;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    };
  },
): Promise<boolean> {
  const requester = await resolveIssueReviewRequester(db, input.issue);
  if (!requester) return false;
  if (requester.reviewInteractionId && requester.reviewInteractionId !== input.interaction.id) return false;
  // Older review transitions did not persist the interaction binding. In that
  // case, an unattributed confirmation is ambiguous and must fail closed.
  // Confirmations attributed to an unrelated writer remain independently
  // resolvable, while requester-created confirmations inherit the issue policy.
  if (!requester.reviewInteractionId
    && !input.interaction.createdByAgentId
    && !input.interaction.createdByUserId) {
    return true;
  }
  return requester.type === "agent"
    ? input.interaction.createdByAgentId === requester.id
    : input.interaction.createdByUserId === requester.id;
}

export async function assertIssueReviewVerdictActorAllowed(
  db: Db,
  input: {
    issue: ReviewPolicyIssue;
    actor: IssueReviewVerdictActor;
    reviewPolicy?: IssueReviewPolicy | null;
  },
): Promise<void> {
  const policy = input.reviewPolicy ?? input.issue.reviewPolicy ?? "anyone";
  if (policy === "anyone") return;

  if (policy === "human_only") {
    if (input.actor.type === "user") return;
    throw forbidden(
      "Review policy `human_only` allows only an authenticated user to approve or reject this review.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "authenticated_user_with_issue_write_access",
        remediation: "Have an authenticated user with issue write access submit the verdict.",
      },
    );
  }

  const requester = await resolveIssueReviewRequester(db, input.issue);
  if (!requester) {
    throw forbidden(
      "Review policy `not_creator` requires a different writer, but the review requester could not be determined.",
      {
        code: "review_policy_denied",
        policy,
        allowedActor: "writer_other_than_review_requester",
        remediation: "Move the issue out of and back into `in_review` to record a requester before another writer submits the verdict.",
      },
    );
  }
  if (requester.type !== input.actor.type || requester.id !== input.actor.id) return;

  throw forbidden(
    "Review policy `not_creator` requires someone other than the writer who moved the issue into `in_review` to approve or reject it.",
    {
      code: "review_policy_denied",
      policy,
      allowedActor: "writer_other_than_review_requester",
      remediation: "Have another writer with issue write access submit the verdict.",
    },
  );
}

export const HUMAN_ONLY_COMPLETION_REVIEW_SYSTEM_ID = "human-only-completion";
export const HUMAN_ONLY_COMPLETION_REVIEW_TARGET_KEY = "native_completion_review";
export const HUMAN_ONLY_COMPLETION_COERCION_MESSAGE =
  "Review policy `human_only` reserves `done` for a person. Your completion was recorded as a pending " +
  "completion review (status `in_review`); the write succeeded and needs no retry.";

/**
 * `human_only` reserves completion for an authenticated user. Instead of
 * persisting an agent's `done`, the write is coerced to `in_review` with a
 * human completion review card (the same `native_completion_review` card the
 * native runtime binds): accepting it as a user sets `done`; rejecting it
 * returns the issue to the agent as `todo`. The agent keeps its assignment and
 * its run is not cancelled, and the pending card is a real review path, so
 * neither the disposition guard nor the stalled-review recovery fires.
 * Callers pass the row as it is before the write and the status the write
 * would persist.
 */
export function shouldCoerceAgentCompletionToReview(input: {
  issue: { status: string; reviewPolicy?: IssueReviewPolicy | null };
  nextStatus: unknown;
  actorAgentId: string | null | undefined;
}): boolean {
  return (
    Boolean(input.actorAgentId) &&
    input.nextStatus === "done" &&
    input.issue.status !== "done" &&
    input.issue.reviewPolicy === "human_only"
  );
}

/**
 * Each card gets its own target revision. Accepting a completion review only
 * sets `done` when no other card for the same revision is unresolved, so a
 * shared revision would let an earlier rejected card block a later approval.
 */
export function buildHumanOnlyCompletionReviewInput(input: {
  runId: string | null | undefined;
  addresseeUserId: string | null | undefined;
}) {
  return {
    kind: "request_confirmation" as const,
    ...(input.runId ? { sourceRunId: input.runId } : {}),
    resolverPolicy: "human_only" as const,
    addresseeAgentId: null,
    addresseeUserId: input.addresseeUserId ?? null,
    title: "Completion review requested",
    summary: "The assigned agent reported this work as done. Review policy `human_only` reserves `done` for a person.",
    continuationPolicy: "wake_assignee" as const,
    payload: {
      version: 1 as const,
      prompt: "The agent reports this work is complete. Approve completion to mark it done, or send it back with a reason.",
      detailsMarkdown: null,
      acceptLabel: "Approve completion",
      rejectLabel: "Continue work",
      allowDeclineReason: true,
      rejectRequiresReason: true,
      supersedeOnUserComment: false,
      target: {
        type: "custom" as const,
        key: HUMAN_ONLY_COMPLETION_REVIEW_TARGET_KEY,
        revisionId: `human-only:${randomUUID()}`,
        label: "Completion decision",
      },
    },
  };
}
