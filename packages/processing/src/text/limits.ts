/** Size limits and waits of the text step. Changing one changes what every text task accepts. */
export const textLimits = {
  /** A model answer, in bytes. */
  responseBytes: 250_000,
  /** A source text, in characters. */
  sourceTextLength: 200_000,
  /** One stored result file, in bytes. */
  resultBytes: 524_288,
  /** One completion manifest, in bytes. */
  completionBytes: 65_536,
  /** One source artifact read back from R2, in bytes. */
  sourceBytes: 8_388_608,
  /**
   * How long storing evidence or a Review may take once the task's own work is done. It is not the task's
   * deadline: the step still finishes storing after its caller has given up waiting.
   */
  retentionMs: 10_000,
} as const;
