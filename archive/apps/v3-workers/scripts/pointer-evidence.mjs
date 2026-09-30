export function summarizePointerEvidence(evidence, thresholdMs = 2000) {
  const strokes=Array.isArray(evidence?.strokes)?evidence.strokes:[];
  const trusted=strokes.filter(s=>s.trusted===true && Number.isFinite(s.durationMs) && s.durationMs>=0);
  return {strokeCount:strokes.length,trustedStrokeCount:trusted.length,
    durationsMs:trusted.map(s=>s.durationMs),maxHoldMs:Math.max(0,...trusted.map(s=>s.durationMs)),
    thresholdMs,continuousHoldObserved:trusted.some(s=>s.durationMs>=thresholdMs),
    prePressMovementObserved:trusted.some(s=>s.prePress?.trusted===true &&
      s.prePress.eventCount>=2 && Number.isFinite(s.prePress.distancePx) && s.prePress.distancePx>0),
    buttonReleased:evidence?.down===false};
}
