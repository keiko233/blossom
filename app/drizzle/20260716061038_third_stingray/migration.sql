ALTER TABLE "oauth_access_token" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "id" text;--> statement-breakpoint
UPDATE "oauth_access_token" SET "id" = "token" WHERE "id" IS NULL;--> statement-breakpoint
UPDATE "oauth_client" SET "id" = "client_id" WHERE "id" IS NULL;--> statement-breakpoint
UPDATE "oauth_consent" SET "id" = 'consent_' || md5("client_id" || ':' || COALESCE("user_id", '') || ':' || ctid::text) WHERE "id" IS NULL;--> statement-breakpoint
UPDATE "oauth_refresh_token" SET "id" = "token" WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "oauth_access_token" DROP CONSTRAINT "oauth_access_token_pkey";--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "oauth_access_token" DROP CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fkey";--> statement-breakpoint
ALTER TABLE "oauth_consent" DROP CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fkey";--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" DROP CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fkey";--> statement-breakpoint
ALTER TABLE "oauth_client" DROP CONSTRAINT "oauth_client_pkey";--> statement-breakpoint
ALTER TABLE "oauth_client" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" DROP CONSTRAINT "oauth_refresh_token_pkey";--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "oauth_access_token" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_token_key" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_client_id_key" UNIQUE("client_id");--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_token_key" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "oauth_refresh_token"("id") ON DELETE CASCADE;
