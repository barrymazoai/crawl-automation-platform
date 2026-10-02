/** Ownership on a TaskSpace handle is a snapshot; always read the current inventory. */
export const EGO_OWNERSHIP = `
const ownSpace = async () => (await listTaskSpaces()).find(space => space.spaceId === params.taskSpaceId);
const requireAgent = async () => {
  const space = await ownSpace();
  if (!space) throw { code: "BROWSER.SPACE_MISSING", name: "Error" };
  if (space.ownership !== "agent") throw { code: "BROWSER.USER_CONTROL", name: "Error" };
};`;
