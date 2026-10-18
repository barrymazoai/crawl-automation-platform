// Headline/summary wording that marks a trade-press item as litigation or
// enforcement news, and the lawsuit_type it maps to (first match wins).
export const ENFORCEMENT_NEWS = [
  /\blawsuits?\b/i,
  /\bsu(?:es|ed|ing)\b/i,
  /class[- ]action/i,
  /\bsettle(?:s|d|ment|ments)\b/i,
  /\blitigation\b/i,
  /\bcourts?\b/i,
  /\bjudge\b/i,
  /\bjury\b/i,
  /\bverdict\b/i,
  /\bFTC\b|Federal Trade Commission/,
  /attorneys? general/i,
  /Department of Justice|\bDOJ\b/,
  /\bindict(?:ed|ment)\b/i,
  /pleads? guilty|guilty plea/i,
  /\bsentenced\b/i,
  /\binjunction\b/i,
  /consent decree/i,
  /\bseized\b/i,
  /warning letters?/i,
  /Prop(?:osition)? 65/i,
  /\benforcement\b/i,
  /\bcrackdown\b/i,
  /\bfine[sd]\b/i,
  /\bcharged with\b/i,
];

export const LAWSUIT_TYPES = [
  ['class_action', /class[- ]action/i],
  ['ftc', /\bFTC\b|Federal Trade Commission/],
  ['state_ag', /attorneys? general/i],
  ['prop65_notice', /Prop(?:osition)? 65/i],
];
