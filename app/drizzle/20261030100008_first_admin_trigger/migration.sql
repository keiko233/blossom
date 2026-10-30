-- Custom SQL migration (Drizzle's schema DSL cannot express triggers).
--
-- The first row ever inserted into "user" becomes an administrator. The claim
-- is the single row of "admin_bootstrap", taken with INSERT ... ON CONFLICT DO
-- NOTHING inside a BEFORE INSERT trigger, so:
--   * it is atomic with the user insert: both commit or both roll back, so a
--     failed insert (duplicate email, any error) does not consume the claim;
--   * concurrent first inserts serialize on the marker's primary key: the loser
--     waits for the winner's transaction, then sees the conflict and stays a
--     plain user; if the winner rolls back, the loser takes the claim;
--   * it is one statement, so it works on neon-http (no interactive
--     transactions) as well as node-postgres;
--   * it applies to every insert path (email, magic link, OAuth, admin plugin).
-- The marker has no foreign key to "user", so deleting users never reopens it.
CREATE FUNCTION "user_claim_first_admin"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "admin_bootstrap" ("id", "claimed_user_id")
  VALUES (true, NEW."id")
  ON CONFLICT ("id") DO NOTHING;
  IF FOUND THEN
    NEW."role" := 'admin';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_claim_first_admin"
BEFORE INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION "user_claim_first_admin"();
--> statement-breakpoint
-- Existing installations: if any user exists, the claim is already spent, so
-- nobody who registers later is promoted (even if every user is later deleted).
-- Creating the trigger above holds a lock on "user" until this migration
-- commits, so no insert can slip between the trigger and this backfill.
INSERT INTO "admin_bootstrap" ("id", "claimed_user_id")
SELECT true, NULL
WHERE EXISTS (SELECT 1 FROM "user")
ON CONFLICT ("id") DO NOTHING;
