import { z } from "zod";

export const PermitCleanupSchema = z.object({
  state: z.enum(["armed", "running", "stopped", "CLEANUP_UNVERIFIED"]),
  attempts: z.number(),
  failure: z.record(z.string(), z.unknown()).nullable(),
  executions: z.array(
    z.object({
      identity: z.record(z.string(), z.unknown()),
      stoppedAt: z.string().nullable(),
      proof: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
});

/** The existing held-permits API exposes actionable missing proof and the exact identities to inspect. */
export const permitCleanupView = `jsonb_build_object(
  'state', coalesce((SELECT state FROM resource_permit_stop WHERE permit_id = p.permit_id),
                    'CLEANUP_UNVERIFIED'),
  'attempts', coalesce((SELECT cleanup_attempts FROM resource_permit_stop
                       WHERE permit_id = p.permit_id), 0),
  'failure', (SELECT failure FROM resource_permit_stop WHERE permit_id = p.permit_id),
  'executions', coalesce((SELECT jsonb_agg(jsonb_build_object(
     'identity', identity, 'stoppedAt', stopped_at, 'proof', proof) ORDER BY recorded_at)
     FROM resource_permit_execution WHERE permit_id = p.permit_id), '[]'::jsonb)
) AS cleanup`;
