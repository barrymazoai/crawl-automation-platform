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
  signal?: AbortSignal;
  threadId?: string;
  threadName?: string;
  skill?: { name: string; path: string };
  onSession?: (session: CodexSession) => void;
};

export interface CodexRunner {
  run(input: CodexRunInput): Promise<unknown>;
  close?(): Promise<void>;
}
