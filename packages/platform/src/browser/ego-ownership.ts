/**
 * Ownership on a TaskSpace handle is a snapshot; always read the current inventory.
 * listTaskSpaces() reports the number as `id` (Ego Lite 0.5, seen 2026-10-02); `spaceId` is kept for handles.
 */
export const EGO_OWNERSHIP = `
const ownSpace = async () => (await listTaskSpaces()).find(space => (space.id ?? space.spaceId) === params.taskSpaceId);
const requireAgent = async () => {
  const space = await ownSpace();
  if (!space) throw { code: "BROWSER.SPACE_MISSING", name: "Error" };
  if (space.ownership !== "agent") throw { code: "BROWSER.USER_CONTROL", name: "Error" };
};`;
