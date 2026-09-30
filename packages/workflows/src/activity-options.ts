/** One attempt per Activity: a failure becomes a Review, never an automatic retry of paid or model work. */
export const once = {
  startToCloseTimeout: "10 minutes",
  scheduleToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
} as const;
