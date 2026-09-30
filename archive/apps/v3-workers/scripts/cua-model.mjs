// User-selected Computer Use model only. Extraction workers remain Luna / medium.
export const CUA_MODEL = 'gpt-6-astra';
export const CUA_EFFORT = 'low';
export function cuaCodexArgs(cwd, {ephemeral = false} = {}) {
  return {
    prefixArgs: ['-a','never','-s','read-only','-c',`model_reasoning_effort="${CUA_EFFORT}"`],
    execArgs: ['--skip-git-repo-check',...(ephemeral ? ['--ephemeral'] : []),'--json','-m',CUA_MODEL,'-C',cwd],
  };
}
