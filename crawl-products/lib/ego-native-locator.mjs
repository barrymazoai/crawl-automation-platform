/** Only the harvest engine's small locator surface, mapped to documented Ego actions. */
export function egoLocator(page, guard, query, index = null) {
  const inspect = async operation => {
    await guard();
    return page.evaluate(({ query: target, index: at, operation: action }) => {
      const candidates = [...document.querySelectorAll(target.css ?? "body *")].filter(element => {
        if (target.text === undefined) return true;
        const actual = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        return target.exact ? actual === target.text : actual.toLowerCase().includes(String(target.text).toLowerCase());
      });
      const selected = at === null ? candidates : candidates.slice(at, at + 1);
      if (action === "count") return selected.length;
      return selected.some(element => {
        const style = getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
      });
    }, { query, index, operation });
  };
  const selector = () => {
    const base = query.css ?? `text=${query.exact ? JSON.stringify(query.text) : query.text}`;
    return index === null ? base : `${base} >> nth=${index}`;
  };
  const options = value => {
    const { timeoutMs, ...rest } = value ?? {};
    return { ...rest, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) };
  };
  return {
    count: () => inspect("count"),
    isVisible: () => inspect("visible"),
    first: () => egoLocator(page, guard, query, 0),
    nth: at => egoLocator(page, guard, query, at),
    click: async value => { await guard(); return page.click(selector(), options(value)); },
    press: async (key, value) => { await guard(); return page.press(selector(), key, options(value)); },
  };
}
