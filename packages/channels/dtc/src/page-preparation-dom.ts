import {
  type allowedContent,
  type productContentScope,
  productContentScopeScript,
} from "@crawl-automation/channels-core";

interface PreparationPolicy {
  allowedContent: typeof allowedContent;
  productContentScope: typeof productContentScope;
}

export function contentTarget(node: Element): string {
  if (
    node.id &&
    node.ownerDocument.querySelectorAll(`[id=${JSON.stringify(node.id)}]`).length === 1
  ) {
    return `[id=${JSON.stringify(node.id)}]`;
  }
  const parts: string[] = [];
  for (let parent: Element | null = node; parent; parent = parent.parentElement) {
    const siblings = [...(parent.parentElement?.children ?? [])].filter(
      (sibling) => sibling.tagName === parent?.tagName,
    );
    parts.unshift(`${parent.localName}:nth-of-type(${siblings.indexOf(parent) + 1 || 1})`);
  }
  return parts.join(" > ");
}

export function contentNodes(document: Document, url: string, policy: PreparationPolicy) {
  const { productContentScope, allowedContent } = policy;
  const scope = productContentScope(document, { url });
  const roots = [scope.root, ...scope.sections].filter((node): node is Element => node !== null);
  const nodes = (selector: string) =>
    [
      ...new Set(
        roots.flatMap((root) => [
          ...(root.matches(selector) ? [root] : []),
          ...root.querySelectorAll(selector),
        ]),
      ),
    ].filter((node) => allowedContent(node, scope.identity));
  return { roots, nodes, identity: scope.identity };
}

export function accordionPanel(
  button: Element,
  content: ReturnType<typeof contentNodes>,
  policy: PreparationPolicy,
) {
  const target = button.getAttribute("aria-controls");
  if (!target || /\s/.test(target)) {
    return null;
  }
  const panels = button.ownerDocument.querySelectorAll(`[id=${JSON.stringify(target)}]`);
  const panel = panels.length === 1 ? panels[0] : null;
  return panel &&
    policy.allowedContent(panel, content.identity) &&
    content.roots.some((root) => root.contains(button) && root.contains(panel))
    ? panel
    : null;
}

export function safeToggle(button: Element): boolean {
  return (
    button.matches('button[aria-expanded="false"][aria-controls]') &&
    !button.closest("form, a, [onclick]") &&
    !button.matches(
      '[type="submit"], [type="reset"], [form], [formaction], [disabled], [aria-disabled="true"], [data-href], [data-url]',
    ) &&
    button.getClientRects().length > 0
  );
}

export function pendingContent(document: Document, url: string, policy: PreparationPolicy) {
  const { nodes } = contentNodes(document, url, policy);
  return {
    details: nodes("details:not([open])").length,
    toggles: nodes('[aria-expanded="false"][aria-controls]').length,
    panels: nodes('[aria-busy="true"], [role="progressbar"]').length,
    images: nodes("img").filter((node) => {
      const image = node as HTMLImageElement;
      return !image.complete || image.naturalWidth === 0;
    }).length,
  };
}

export function preparationAction(
  document: Document,
  input: { url: string; attempted: string[] },
  policy: PreparationPolicy,
) {
  const content = contentNodes(document, input.url, policy);
  const targets = content.nodes(
    'details:not([open]), button[aria-expanded="false"][aria-controls]',
  );
  const node = targets.find((target) => {
    if (input.attempted.includes(contentTarget(target))) {
      return false;
    }
    return (
      target.matches("details") || (safeToggle(target) && accordionPanel(target, content, policy))
    );
  });
  if (!node) {
    return null;
  }
  const kind = node.matches("details") ? ("details" as const) : ("accordion" as const);
  return {
    kind,
    target: contentTarget(node),
    label: (node.querySelector("summary")?.textContent ?? node.textContent ?? "")
      .trim()
      .slice(0, 160),
    revealed: false,
  };
}

export function preparationDomScript(): string {
  return [
    productContentScopeScript(),
    contentTarget.toString(),
    contentNodes.toString(),
    accordionPanel.toString(),
    safeToggle.toString(),
    pendingContent.toString(),
    preparationAction.toString(),
    "const preparationPolicy = { productContentScope, allowedContent };",
  ].join("\n");
}
