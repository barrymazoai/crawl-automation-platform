import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addCounts, batchId, monthRange, monthsBack, tableToObjects, toBatches, toSlices } from '../src/slices.mjs';

const imp = (time, cty, value, qty, over = {}) => ({
  time,
  CTY_CODE: cty,
  CTY_NAME: `C${cty}`,
  CON_VAL_MO: String(value),
  CON_QY1_MO: String(qty),
  GEN_VAL_MO: String(value),
  UNIT_QY1: 'KG',
  SUMMARY_LVL: 'DET',
  I_COMMODITY_LDESC: 'TUMERIC (CURCUMA)',
  ...over,
});

describe('months', () => {
  it('ranges across years and counts back', () => {
    assert.deepEqual(monthRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
    assert.equal(monthsBack('2026-09', 35), '2023-10');
    assert.equal(monthsBack('2026-09', 0), '2026-09');
    assert.throws(() => monthRange('2026-03', '2026-02'));
  });
});

describe('tableToObjects', () => {
  it('turns the Census table into objects', () => {
    assert.deepEqual(tableToObjects([['A', 'B'], ['1', '2']]), [{ A: '1', B: '2' }]);
    assert.throws(() => tableToObjects({ error: 'x' }));
  });
});

describe('toSlices (KAN-282)', () => {
  const months = ['2026-08', '2026-09'];

  it('keeps countries, drops groups, the total and all-zero rows; empty month = empty slice', () => {
    const rows = [
      imp('2026-08', '5330', 4000, 1000),
      imp('2026-08', '6863', 0, 0), // traded earlier in the year, not this month
      imp('2026-08', '0003', 9999, 1, { SUMMARY_LVL: 'CGP' }), // EU group
      imp('2026-08', '-', 4000, 1000, { CTY_NAME: 'TOTAL FOR ALL COUNTRIES' }),
      imp('2026-07', '5330', 1, 1), // outside the window
    ];
    const s = toSlices('import', '0910300000', rows, months);
    assert.equal(s.length, 2);
    assert.deepEqual(s[0], {
      direction: 'import',
      code: '0910300000',
      month: '2026-08',
      description: 'TUMERIC (CURCUMA)',
      unit: 'KG',
      rows: [{ ctyCode: '5330', ctyName: 'C5330', valueUsd: 4000, qty: 1000, generalValueUsd: 4000 }],
    });
    assert.deepEqual(s[1].rows, []);
  });

  it('exports carry no general value; unit X gives a null quantity', () => {
    const exp = [{ time: '2026-09', CTY_CODE: '1220', CTY_NAME: 'CANADA', ALL_VAL_MO: '67914', QTY_1_MO: '0', UNIT_QY1: 'X', SUMMARY_LVL: 'DET', E_COMMODITY_LDESC: 'D' }];
    const s = toSlices('export', '2936270000', exp, ['2026-09']);
    assert.deepEqual(s[0].rows, [{ ctyCode: '1220', ctyName: 'CANADA', valueUsd: 67914, qty: null }]);
    assert.equal(s[0].unit, 'X');
  });

  it('a value with zero quantity is kept; bad numbers and two units stop the run', () => {
    assert.equal(toSlices('import', 'c', [imp('2026-09', '5330', 10, 0)], ['2026-09'])[0].rows.length, 1);
    assert.throws(() => toSlices('import', 'c', [imp('2026-09', '5330', 'n/a', 1)], ['2026-09']), /not a whole/);
    assert.throws(() => toSlices('import', 'c', [imp('2026-09', '5330', 1.5, 1)], ['2026-09']), /not a whole/);
    assert.throws(
      () => toSlices('import', 'c', [imp('2026-09', '5330', 1, 1), imp('2026-09', '6863', 1, 1, { UNIT_QY1: 'NO' })], ['2026-09']),
      /more than one unit/,
    );
  });

  it('no Census rows (204) gives every month as an empty slice', () => {
    const s = toSlices('import', '1211201500', [], months);
    assert.deepEqual(s.map((x) => [x.month, x.rows.length, x.unit]), [['2026-08', 0, null], ['2026-09', 0, null]]);
  });
});

describe('toBatches', () => {
  const slice = (n) => ({ direction: 'import', code: 'c', month: 'm', rows: Array.from({ length: n }, () => ({})) });

  it('caps slices and rows per batch and never splits a slice', () => {
    const b = toBatches([slice(3), slice(3), slice(3)], { maxSlices: 2, maxRows: 5 });
    assert.deepEqual(b.map((x) => x.map((s) => s.rows.length)), [[3], [3], [3]]);
    const c = toBatches([slice(1), slice(1), slice(1)], { maxSlices: 2, maxRows: 100 });
    assert.deepEqual(c.map((x) => x.length), [2, 1]);
    assert.throws(() => toBatches([slice(6)], { maxRows: 5 }));
  });

  it('numbers batches and sums nested counts', () => {
    assert.equal(batchId(0), '0001');
    assert.deepEqual(addCounts({ rows: { inserted: 1 } }, { rows: { inserted: 2, removed: 1 }, slices: { received: 3 } }), {
      rows: { inserted: 3, removed: 1 },
      slices: { received: 3 },
    });
  });
});
