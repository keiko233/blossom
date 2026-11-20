CREATE TABLE "managed_rule_set_asset" (
	"rule_set_id" text,
	"version" text,
	"format" text NOT NULL,
	"source" text NOT NULL,
	"content_base64" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "managed_rule_set_asset_pkey" PRIMARY KEY("rule_set_id","version"),
	CONSTRAINT "managed_rule_set_asset_size" CHECK ("size_bytes" BETWEEN 1 AND 524288),
	CONSTRAINT "managed_rule_set_asset_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "managed_rule_set_asset_format" CHECK ("format" = 'binary')
);
