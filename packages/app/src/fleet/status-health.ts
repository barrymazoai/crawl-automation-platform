import type {
  FleetIssue,
  FleetJobObservation,
  FleetJobStatus,
  WorkerHeartbeat,
} from "./status-ports.js";

export function fleetIssue(error: unknown): FleetIssue {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return {
    code: typeof code === "string" || typeof code === "number" ? code : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function jobStatus(job: FleetJobObservation, now: number): FleetJobStatus {
  const { heartbeat, process, queues, ...runtime } = job;
  const reportedAt = heartbeat ? Date.parse(heartbeat.lastHeartbeat) : NaN;
  const stale = !Number.isFinite(reportedAt) || now - reportedAt > 15_000;
  const reason = healthReason(job, { now, reportedAt, stale });
  return {
    ...runtime,
    uptimeMs: uptime(job, now),
    health: {
      process: heartbeat?.process ?? process,
      queues,
      ...heartbeatFields(heartbeat),
      stale,
      ready: reason === "ready",
      reason,
    },
  };
}

function uptime(job: FleetJobObservation, now: number): number | null {
  if (job.pid <= 0) {
    return 0;
  }
  return job.startedAt === null ? null : Math.max(0, now - job.startedAt);
}

function heartbeatFields(heartbeat: WorkerHeartbeat | null) {
  return {
    running: heartbeat?.running ?? null,
    pid: heartbeat?.pid ?? null,
    lastHeartbeat: heartbeat?.lastHeartbeat ?? null,
  };
}

function healthReason(
  job: FleetJobObservation,
  time: { now: number; reportedAt: number; stale: boolean },
): string {
  if (job.status !== "online" || job.pid <= 0) {
    return "process-not-running";
  }
  const beat = job.heartbeat;
  if (!beat) {
    return "health-missing-or-invalid";
  }
  if (beat.pid !== job.pid || beat.process !== job.process) {
    return "health-identity-mismatch";
  }
  if (time.stale) {
    return "health-stale";
  }
  if (!withinStartWindow(job.startedAt, time)) {
    return "health-outside-start-window";
  }
  return beat.running ? "ready" : "worker-stopped";
}

function withinStartWindow(start: number | null, time: { now: number; reportedAt: number }) {
  return start !== null && time.reportedAt >= start && time.reportedAt <= time.now;
}
