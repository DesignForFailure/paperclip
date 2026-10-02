CREATE TABLE "runtime_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_facts" ADD CONSTRAINT "runtime_facts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_facts_company_kind_key_idx" ON "runtime_facts" USING btree ("company_id","kind","key");--> statement-breakpoint
CREATE INDEX "runtime_facts_company_kind_observed_idx" ON "runtime_facts" USING btree ("company_id","kind","observed_at");