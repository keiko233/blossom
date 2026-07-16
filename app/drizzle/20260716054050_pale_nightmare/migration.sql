CREATE TABLE IF NOT EXISTS "mcp_tool_audit" (
	"id" text PRIMARY KEY,
	"actor_user_id" text,
	"source" text NOT NULL,
	"tool" text NOT NULL,
	"redacted_input" text,
	"redacted_output" text,
	"redacted_error" text,
	"status" text NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jwks" (
	"id" text PRIMARY KEY,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_access_token" (
	"token" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"refresh_id" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"scopes" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client" (
	"client_id" text PRIMARY KEY,
	"client_secret" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" jsonb,
	"user_id" text,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" jsonb,
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" jsonb NOT NULL,
	"post_logout_redirect_uris" jsonb,
	"token_endpoint_auth_method" text,
	"grant_types" jsonb,
	"response_types" jsonb,
	"public" boolean,
	"type" text,
	"require_pkce" boolean,
	"reference_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_consent" (
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_refresh_token" (
	"token" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked" timestamp,
	"auth_time" timestamp,
	"scopes" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tool_audit_actor_idx" ON "mcp_tool_audit" ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tool_audit_source_idx" ON "mcp_tool_audit" ("source","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tool_audit_tool_idx" ON "mcp_tool_audit" ("tool","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_client_idx" ON "oauth_access_token" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_user_idx" ON "oauth_access_token" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_session_idx" ON "oauth_access_token" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_refresh_idx" ON "oauth_access_token" ("refresh_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_user_idx" ON "oauth_client" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_client_idx" ON "oauth_consent" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_user_idx" ON "oauth_consent" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_client_idx" ON "oauth_refresh_token" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_user_idx" ON "oauth_refresh_token" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_session_idx" ON "oauth_refresh_token" ("session_id");--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_tool_audit_actor_user_id_user_id_fkey') THEN
		ALTER TABLE "mcp_tool_audit" ADD CONSTRAINT "mcp_tool_audit_actor_user_id_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_access_token_client_id_oauth_client_client_id_fkey') THEN
		ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_access_token_session_id_session_id_fkey') THEN
		ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_access_token_user_id_user_id_fkey') THEN
		ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_client_user_id_user_id_fkey') THEN
		ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_consent_client_id_oauth_client_client_id_fkey') THEN
		ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_consent_user_id_user_id_fkey') THEN
		ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_refresh_token_client_id_oauth_client_client_id_fkey') THEN
		ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE CASCADE;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_refresh_token_session_id_session_id_fkey') THEN
		ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE SET NULL;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_refresh_token_user_id_user_id_fkey') THEN
		ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
	END IF;
END $$;
