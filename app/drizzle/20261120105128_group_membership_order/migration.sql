ALTER TABLE "node_group" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_group" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Backfill deterministic zero-based membership positions per group using the
-- stable entrance ID (`node_id`) as the final tie-breaker before enforcing
-- `(group_id, position)` uniqueness.
WITH "ranked" AS (
	SELECT
		"node_group"."group_id",
		"node_group"."node_id",
		(ROW_NUMBER() OVER (
			PARTITION BY "node_group"."group_id"
			ORDER BY "node_group"."position" ASC, "node_group"."node_id" ASC
		) - 1)::integer AS "next_position"
	FROM "node_group"
)
UPDATE "node_group"
SET "position" = "ranked"."next_position"
FROM "ranked"
WHERE "node_group"."group_id" = "ranked"."group_id"
  AND "node_group"."node_id" = "ranked"."node_id";--> statement-breakpoint
ALTER TABLE "node_group" ADD CONSTRAINT "node_group_group_position_unique" UNIQUE("group_id","position") DEFERRABLE INITIALLY IMMEDIATE;