/** A committed DOM-ready page remains inspectable when optional load resources time out. */
export const EGO_AGENT_NAVIGATION = `
  const navigate = async url => {
    await requireAgent();
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch (error) {
      if (error?.name !== "PageNavigationTimeoutError"
        || !String(error.message).includes("navigation committed at")) throw error;
      await requireAgent();
      const current = await page.evaluate(() => ({ url: location.href, readyState: document.readyState }));
      if (current.url !== new URL(url).href || !["interactive", "complete"].includes(current.readyState)) throw error;
      const receipt = { policy: "inspect-committed-navigation/1", targetId: params.targetId,
        requestedUrl: url, ...current, warning: String(error.message), observedAt: new Date().toISOString() };
      await appendFile(new URL("browser-preparation.jsonl", import.meta.url), JSON.stringify(receipt) + "\\n");
      return receipt;
    }
  };
`;
