ALTER TABLE "certificate_material" ADD COLUMN "domains" jsonb;--> statement-breakpoint
UPDATE "certificate_material" SET "domains" = "managed_certificate"."domains"
FROM "managed_certificate"
WHERE "certificate_material"."certificate_id" = "managed_certificate"."id";--> statement-breakpoint
ALTER TABLE "certificate_material" ALTER COLUMN "domains" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_certificate" ADD COLUMN "pending_material_version" integer;