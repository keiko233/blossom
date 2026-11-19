CREATE TABLE "server_metric_minute" (
	"server_id" text,
	"minute" timestamp,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"cpu_percent" double precision,
	"memory_used_bytes" bigint,
	"memory_total_bytes" bigint,
	"disk_used_bytes" bigint,
	"disk_total_bytes" bigint,
	"network_tx_bytes_per_second" double precision,
	"network_rx_bytes_per_second" double precision,
	"received_at" timestamp NOT NULL,
	CONSTRAINT "server_metric_minute_pkey" PRIMARY KEY("server_id","minute"),
	CONSTRAINT "server_metric_minute_scope_check" CHECK ("scope" in ('host', 'container'))
);
--> statement-breakpoint
CREATE INDEX "server_metric_minute_minute_idx" ON "server_metric_minute" ("minute");--> statement-breakpoint
ALTER TABLE "server_metric_minute" ADD CONSTRAINT "server_metric_minute_server_id_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "server"("id") ON DELETE CASCADE;