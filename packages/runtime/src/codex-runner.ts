export type CodexSession = {
  threadId: string;
  turnId?: string;
};

export type CodexRunInput = {
  prompt: string;
  cwd: string;
  schemaPath: string;
  outputPath: string;
  eventLogPath: string;
  addDirectories?: string[];
  /** Images attached to the initial Codex turn through `codex exec --image`. */
  imagePaths?: string[];
  signal?: AbortSignal;
  /** 本次调用保留会话 rollout（默认 --ephemeral）。用于周期性留下含限额快照的会话文件。 */
  persistSession?: boolean;
  threadId?: string;
  threadName?: string;
  skill?: { name: string; path: string };
  onSession?: (session: CodexSession) => void;
};

export interface CodexRunner {
  run(input: CodexRunInput): Promise<unknown>;
  close?(): Promise<void>;
}
