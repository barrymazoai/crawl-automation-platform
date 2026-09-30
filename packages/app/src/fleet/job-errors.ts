import { defineErrors } from "@crawl-automation/platform";

const runtime = (message: string) => ({ category: "RUNTIME" as const, message });

export const jobErrors = defineErrors({
  "JOBS.APPLY_FAILED": runtime("Job deployment stopped; inspect progress before manual recovery."),
  "JOBS.UNHEALTHY": runtime("Jobs did not produce current, matching health evidence in time."),
  "JOBS.NAME_CONFLICT": runtime("A new job name already belongs to a process outside this file."),
  "JOBS.INVALID_PLAN": runtime("Job names must be unique and health polling must be bounded."),
});
