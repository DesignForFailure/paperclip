-- An issue's updated_at is the version a conditional PATCH names (expectedUpdatedAt), compared at the millisecond
-- precision the API gives. Two writes within one millisecond, or a writer whose clock is behind the row's, would
-- leave two versions with one stamp, and a client that read the first would pass against the second. Every update
-- that sets updated_at, whoever makes it (the issue service, the wake queue, run dispatch, heartbeat bookkeeping), is
-- therefore moved at least one millisecond past the row's own millisecond, here, under the row lock of that update.
-- It does not need a new value to differ: a writer naming the row's exact millisecond is the case itself.
-- Left as they are: an update that does not set updated_at; one that changes nothing in the row, which is no new
-- version (an import's "bump recency, never backwards", greatest(updated_at, x), when x is older); and a migration's
-- (the runner sets paperclip.applying_migrations for its transaction, packages/db/src/client.ts): a repair means the
-- value it writes, and no client version races a migration.
CREATE OR REPLACE FUNCTION paperclip_issue_updated_at_version()
RETURNS trigger AS $$
BEGIN
	IF current_setting('paperclip.applying_migrations', true) IS DISTINCT FROM 'on'
		AND NEW IS DISTINCT FROM OLD
		AND date_trunc('milliseconds', NEW."updated_at") <= date_trunc('milliseconds', OLD."updated_at") THEN
		NEW."updated_at" := date_trunc('milliseconds', OLD."updated_at") + interval '1 millisecond';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_updated_at_version_trigger ON "issues";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_updated_at_version_trigger
BEFORE UPDATE OF "updated_at" ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_issue_updated_at_version();
