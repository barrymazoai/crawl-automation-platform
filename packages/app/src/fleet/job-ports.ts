/** A machine-owned process, independent of its process manager. */
export interface JobDefinition {
  name: string;
  script: string;
  args: string[];
  cwd: string;
  interpreter: string;
  env: Record<string, string>;
  outFile: string;
  errorFile: string;
}

export interface JobStart {
  pid: number;
  startedAt: number;
}

export interface JobHealth {
  name: string;
  ready: boolean;
  reason: string;
}

export interface JobRunner {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  list(): Promise<string[]>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  start(job: JobDefinition): Promise<JobStart>;
  health(job: JobDefinition, start?: JobStart): Promise<JobHealth>;
}

export interface JobProcessFile {
  /** Missing file means a first deployment; malformed files must fail. */
  read(): Promise<JobDefinition[]>;
  /** Preserve the original bytes before atomically replacing the machine's process file. */
  replace(jobs: readonly JobDefinition[]): Promise<{ backup: string | null }>;
}

export interface JobServicePorts {
  runner: JobRunner;
  file: JobProcessFile;
  sleep(milliseconds: number): Promise<void>;
}

export interface JobDeployment {
  jobs: JobDefinition[];
  health: { attempts: number; intervalMs: number };
}

export interface JobChange {
  changed: string[];
  removed: string[];
  unchanged: string[];
}

/** Only acknowledged operations appear here; the failed operation may have an unknown outcome. */
export interface JobProgress extends JobChange {
  backup: string | null;
  written: boolean;
  stopped: string[];
  removedFromRunner: string[];
  started: string[];
  phase: string;
  job: string | null;
}
