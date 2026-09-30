import { defineErrors } from "@crawl-automation/platform";

const runtime = (message: string) => ({ category: "RUNTIME" as const, message });

export const pm2Errors = defineErrors({
  "PM2.OPERATION_FAILED": runtime("PM2 rejected a process operation."),
  "PM2.DAEMON_REQUIRED": runtime("Set PM2_HOME and start that PM2 daemon by hand first."),
  "PM2.ATTACH_UNSUPPORTED": runtime("This PM2 client cannot guarantee manual-only daemon startup."),
  "PM2.PROCESS_CONFLICT": runtime("PM2 process identity is missing, duplicated or still running."),
  "PM2.FILE_INVALID": runtime("The process file is not a generated PM2 ecosystem file."),
  "PM2.FILE_CHANGED": runtime("The process file changed after it was read."),
  "PM2.FILE_WRITE_FAILED": runtime("Could not replace the process file; inspect the backup path."),
});
