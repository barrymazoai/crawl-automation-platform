export function prepareCatalogScript(input: {
  profileDir: string;
  cwd: string;
  outDir: string;
  skillRoot: string;
  sourceUrl: string;
  taskSpaceId: number;
  label: string;
  targetId: string;
}): Promise<void>;
export function retainCatalogScript(input: {
  profileDir: string;
  root: string;
  sourceUrl: string;
}): Promise<unknown>;
