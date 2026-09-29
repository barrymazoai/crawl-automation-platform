import { z } from "zod";
import { deployErrors } from "./deploy-errors.js";

/** The control script's `status <id>` answer: each job it reports, with whether it counts as ready. */
const StatusAnswerSchema = z.object({
  jobs: z.array(z.object({ id: z.string(), ready: z.boolean() }).passthrough()),
});

/** Whether every job reports ready. An answer that cannot be read stops the deployment; it is never "healthy". */
export function jobsHealthy(ids: readonly string[], answers: readonly string[]): boolean {
  const reported = answers.flatMap((answer) => readAnswer(answer).jobs);
  return ids.every((id) => reported.some((job) => job.id === id && job.ready));
}

function readAnswer(answer: string) {
  try {
    return StatusAnswerSchema.parse(JSON.parse(answer));
  } catch (error) {
    throw deployErrors.create("DEPLOY.HEALTH_UNREADABLE", { cause: error });
  }
}
