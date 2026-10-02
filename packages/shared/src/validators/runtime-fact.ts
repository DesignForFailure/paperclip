import { z } from "zod";

/** Lower-case identifier of a fact family, e.g. `runtime`, `model_slot`, `cron_job`, `cron_run`. */
export const runtimeFactKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "kind must be a lower-case identifier of at most 64 characters");

/** The reporter's own id for the fact within its kind. */
export const runtimeFactKeySchema = z.string().min(1).max(512);

export const RUNTIME_FACT_DATA_MAX_BYTES = 64 * 1024;
export const RUNTIME_FACT_LIST_DEFAULT_LIMIT = 200;
export const RUNTIME_FACT_LIST_MAX_LIMIT = 1000;

export const upsertRuntimeFactSchema = z.object({
  data: z
    .record(z.string(), z.unknown())
    // TextEncoder, not Buffer: this package is also bundled for the browser.
    .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= RUNTIME_FACT_DATA_MAX_BYTES, {
      message: `data must serialize to at most ${RUNTIME_FACT_DATA_MAX_BYTES} bytes`,
    }),
  /** When the reporter saw the fact; defaults to now. */
  observedAt: z.string().datetime({ offset: true }).optional(),
});

export type UpsertRuntimeFact = z.infer<typeof upsertRuntimeFactSchema>;

export interface RuntimeFact {
  id: string;
  companyId: string;
  kind: string;
  key: string;
  data: Record<string, unknown>;
  observedAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
}
