const marker = '//# sourceMappingURL=data:application/json;charset=utf-8;base64,';

/** Runtime identity depends on executable code, not host-specific compiler maps.
 * Temporal requires an inline map. Generate a truthful line map back to the
 * normalized bundled JavaScript; retain the compiler's TypeScript map separately.
 */
export function portableWorkflowBundle(raw: string): {code: string; compilerSourceMap: string} {
  const index = raw.lastIndexOf(marker);
  if (index < 1) throw Error('DTC.WORKFLOW_SOURCE_MAP_MISSING');
  const compilerSourceMap = Buffer.from(raw.slice(index + marker.length).trim(), 'base64').toString('utf8');
  const original = JSON.parse(compilerSourceMap) as {version?:number;sources?:unknown;mappings?:unknown};
  if (original.version !== 3 || !Array.isArray(original.sources) || typeof original.mappings !== 'string')
    throw Error('DTC.WORKFLOW_SOURCE_MAP_INVALID');
  // Actual CRLF characters are JavaScript line terminators. Escaped \\r and
  // \\n string contents are left intact. Reject other CRs rather than guessing.
  const executable = raw.slice(0, index).replaceAll('\r\n', '\n');
  if (executable.includes('\r')) throw Error('DTC.WORKFLOW_LINE_ENDING_UNSUPPORTED');
  const lines = executable.split('\n').length;
  const sourceMap = {
    version: 3, file: 'product-workflows.cjs', sourceRoot: '',
    sources: ['product-workflows.generated.js'], sourcesContent: [executable], names: [],
    // Generated column 0 -> source column 0 of the same line. VLQ AACA advances
    // the original line by one; source index and original column stay at zero.
    mappings: ['AAAA', ...Array<string>(lines - 1).fill('AACA')].join(';'),
  };
  return {
    code: executable + marker + Buffer.from(JSON.stringify(sourceMap)).toString('base64') + '\n',
    compilerSourceMap: JSON.stringify(original) + '\n',
  };
}
