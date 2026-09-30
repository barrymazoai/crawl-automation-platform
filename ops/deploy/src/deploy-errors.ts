import { defineErrors } from "@crawl-automation/platform";

const runtime = (message: string) => ({ category: "RUNTIME" as const, message });

/** Errors of the deploy command. Each stops the deployment where it is; nothing is rolled forward blindly. */
export const deployErrors = defineErrors({
  "DEPLOY.MIGRATIONS_NOT_CONFIGURED": runtime("--migrate needs a `migrations` section."),
  "DEPLOY.RELEASE_EXISTS": runtime(
    "The release directory already exists; a release is always a fresh clone.",
  ),
  "DEPLOY.ENV_MISSING": runtime(
    "A variable the step needs is not set in the operator's environment.",
  ),
  "DEPLOY.COMMAND_FAILED": runtime("A deployment command failed."),
  "DEPLOY.HEALTH_UNREADABLE": runtime("The control script's status answer could not be read."),
  "DEPLOY.UNHEALTHY": runtime("A job did not become healthy in time."),
  "DEPLOY.COMMIT_INVALID": runtime("Deploy a full 40-character commit of origin main."),
  "DEPLOY.UNEXPECTED_FAILURE": runtime("Deployment stopped after an unexpected failure."),
});
