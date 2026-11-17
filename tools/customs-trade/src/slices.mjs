// Census answers → Supply Smart slices (pure; no I/O). Contract: supply-smart-mono
// docs/packages/database-api/domains/customs-trade-ingest.md (customsTrade.ingest, KAN-282).

/** Fields asked from Census, per direction */
export const FIELDS = {
  import: ['CTY_CODE', 'CTY_NAME', 'CON_VAL_MO', 'CON_QY1_MO', 'UNIT_QY1', 'GEN_VAL_MO', 'SUMMARY_LVL', 'I_COMMODITY_LDESC'],
  export: ['CTY_CODE', 'CTY_NAME', 'ALL_VAL_MO', 'QTY_1_MO', 'UNIT_QY1', 'SUMMARY_LVL', 'E_COMMODITY_LDESC'],
};
const VALUE = { import: 'CON_VAL_MO', export: 'ALL_VAL_MO' };
const QTY = { import: 'CON_QY1_MO', export: 'QTY_1_MO' };
const DESC = { import: 'I_COMMODITY_LDESC', export: 'E_COMMODITY_LDESC' };

export const MAX_SLICES = 200;
export const MAX_ROWS = 5000;

/** 'YYYY-MM' months from..to inclusive */
export function monthRange(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (y > ty || (y === ty && m > tm)) throw new Error(`month range ${from}..${to} is empty`);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) [y, m] = [y + 1, 1];
  }
  return out;
}

/** The month n months before 'YYYY-MM' (n = 0 → the same month) */
export function monthsBack(month, n) {
  let [y, m] = month.split('-').map(Number);
  m -= n;
  while (m < 1) [y, m] = [y - 1, m + 12];
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Census table ([[header…], [row…]…]) → objects */
export function tableToObjects(table) {
  if (!Array.isArray(table) || !Array.isArray(table[0])) throw new Error('Census answer is not a table');
  const [header, ...rows] = table;
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const whole = (v, what) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what}: not a whole non-negative number: ${JSON.stringify(v)}`);
  return n;
};

/**
 * Every month of [from, to] for one direction × code as a slice. Census rows of country groups
 * (codes 0001–0027) and the '-' total are dropped, as are rows with value and quantity both 0
 * (Census lists every country that traded the code earlier in the year). A month without rows is
 * an empty slice: no trade that month.
 */
export function toSlices(direction, code, rows, months) {
  const inRange = rows.filter((r) => months.includes(r.time));
  const units = [...new Set(inRange.map((r) => r.UNIT_QY1).filter(Boolean))];
  if (units.length > 1) throw new Error(`${direction} ${code}: more than one unit (${units.join(', ')})`);
  const unit = units[0] ?? null;
  const description = inRange.map((r) => r[DESC[direction]]).find(Boolean) ?? null;
  const byMonth = new Map(months.map((m) => [m, []]));
  for (const r of inRange) {
    if (r.SUMMARY_LVL !== 'DET' || !/^[1-9]\d{3}$/.test(r.CTY_CODE ?? '')) continue;
    const at = `${direction} ${code} ${r.time} ${r.CTY_CODE}`;
    const valueUsd = whole(r[VALUE[direction]], `${at} value`);
    const qty = whole(r[QTY[direction]], `${at} quantity`);
    if (valueUsd === 0 && qty === 0) continue;
    // X = the code has no quantity: null, not 0
    const row = { ctyCode: r.CTY_CODE, ctyName: String(r.CTY_NAME).trim(), valueUsd, qty: unit === 'X' ? null : qty };
    if (direction === 'import') row.generalValueUsd = whole(r.GEN_VAL_MO, `${at} general value`);
    byMonth.get(r.time).push(row);
  }
  return months.map((month) => ({ direction, code, month, description, unit, rows: byMonth.get(month) }));
}

/** Slices → batches of at most MAX_SLICES slices and MAX_ROWS rows (a slice is never split) */
export function toBatches(slices, { maxSlices = MAX_SLICES, maxRows = MAX_ROWS } = {}) {
  const batches = [];
  let cur = [];
  let rows = 0;
  for (const s of slices) {
    if (s.rows.length > maxRows) throw new Error(`slice ${s.direction} ${s.code} ${s.month} has ${s.rows.length} rows`);
    if (cur.length && (cur.length >= maxSlices || rows + s.rows.length > maxRows)) {
      batches.push(cur);
      cur = [];
      rows = 0;
    }
    cur.push(s);
    rows += s.rows.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export const batchId = (i) => String(i + 1).padStart(4, '0');

/** Adds numeric leaves of b into a (counts of the ingest answers) */
export function addCounts(a, b) {
  for (const [k, v] of Object.entries(b ?? {})) {
    if (typeof v === 'number') a[k] = (a[k] ?? 0) + v;
    else if (v && typeof v === 'object') addCounts((a[k] ??= {}), v);
  }
  return a;
}
