/** A committed DOM-ready page remains inspectable when optional load resources time out. */
export const EGO_AGENT_NAVIGATION = `
  const inspectNavigation = async url => {
    await requireAgent();
    const landed = await page.evaluate(() => ({
      href: location.href,
      redirectCount: performance.getEntriesByType("navigation")[0]?.redirectCount ?? 0,
      html: document.documentElement.outerHTML,
      readyState: document.readyState,
    }));
    if (isRecordedProductMove(url, landed.href, landed.redirectCount)) {
      // Owner 2026-10-25: retain the landing DOM before reporting a product move.
      await retainMovedOriginal(workDir, { requestedUrl: url, actualUrl: landed.href,
        html: landed.html, targetId: params.targetId });
      throw new Error("SOURCE.PAGE_MOVED");
    }
    return landed;
  };
  const navigate = async url => {
    await requireAgent();
    try {
      const result = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await inspectNavigation(url);
      return result;
    } catch (error) {
      if (error?.name !== "PageNavigationTimeoutError"
        || !String(error.message).includes("navigation committed at")) throw error;
      await requireAgent();
      const current = await inspectNavigation(url);
      if (current.href !== new URL(url).href || !["interactive", "complete"].includes(current.readyState)) throw error;
      const receipt = { policy: "inspect-committed-navigation/1", targetId: params.targetId,
        requestedUrl: url, url: current.href, readyState: current.readyState,
        warning: String(error.message), observedAt: new Date().toISOString() };
      await appendFile(new URL("browser-preparation.jsonl", import.meta.url), JSON.stringify(receipt) + "\\n");
      return receipt;
    }
  };
`;
