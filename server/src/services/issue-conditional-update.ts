import { conflict } from "../errors.js";

/**
 * A conditional issue update: PATCH /issues/:id with `expectedUpdatedAt`, the
 * `updatedAt` the client read. The update applies only while the issue still
 * has it; otherwise the request answers 409 `issue_changed` with the issue as
 * it is now, and writes nothing. Without the field the update is unconditional,
 * as before.
 *
 * The comparison is at millisecond precision. `issues.updated_at` holds
 * microseconds when Postgres wrote it (the column default, `now()`, at insert),
 * while every date the API gives is `Date#toJSON`, in milliseconds, and the
 * driver's `Date` already drops the rest: drizzle maps the column through
 * `new Date(text)`, which keeps three fractional digits and truncates the
 * others. Comparing microseconds would refuse every client of an issue never
 * updated since it was made.
 *
 * Milliseconds tell two versions apart only if no update gives the row the
 * millisecond it already has, which two updates within one millisecond, or a
 * clock behind the row's, otherwise do: a client that read the first would pass
 * against the second. A trigger moves every update that sets `updated_at` at
 * least one millisecond past the row's own, whoever writes it
 * (packages/db/src/migrations/0286_issue_updated_at_version.sql).
 */
export const ISSUE_CHANGED_CODE = "issue_changed";

/** Whether the row's `updatedAt` is the version the client read, at millisecond precision. */
export function sameIssueVersion(updatedAt: Date, expected: Date): boolean {
  return Math.trunc(updatedAt.getTime()) === Math.trunc(expected.getTime());
}

/** The 409 for a conditional update of an issue that changed: the current issue rides in `details.issue`. */
export function issueChangedConflict(
  current: { updatedAt: Date } & Record<string, unknown>,
  expected: Date,
) {
  return conflict(
    "This issue changed after the version this update expected (expectedUpdatedAt). Read it again and retry.",
    {
      code: ISSUE_CHANGED_CODE,
      expectedUpdatedAt: expected.toISOString(),
      updatedAt: current.updatedAt.toISOString(),
      issue: current,
    },
  );
}
