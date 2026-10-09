import type {
  ProductIngestBatchAnswer,
  ProductVerifyBatchAnswer,
} from "@crawl-automation/v3-contracts";
import type { MappedDelivery } from "./wire.js";
import { productDeliveryErrors } from "./errors.js";

export function acceptedItems(
  answer: ProductIngestBatchAnswer,
  input: { runId: string; products: MappedDelivery[] },
) {
  const refs = input.products.map(({ item }) => item.clientRef);
  if (
    answer.runId !== input.runId ||
    answer.results.length !== refs.length ||
    new Set(answer.results.map((result) => result.clientRef)).size !== refs.length ||
    answer.results.some((result) => !refs.includes(result.clientRef))
  ) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.ANSWER_MISMATCH");
  }
  return input.products.map((product) => {
    const result = answer.results.find((entry) => entry.clientRef === product.item.clientRef);
    const reason = result?.error
      ? `${result.error.code}: ${result.error.message}`
      : result?.status !== "ok"
        ? "PRODUCT_DELIVERY.INGEST_FAILED"
        : (result.observationSkipped ??
          (result.identity?.state === "needs_review" ? "needs_review" : null));
    return { product, reason };
  });
}

export function verificationProblems(
  answer: ProductVerifyBatchAnswer,
  input: { runId: string; products: MappedDelivery[] },
) {
  const refs = input.products.map(({ item }) => item.clientRef);
  const exact =
    answer.runId === input.runId &&
    answer.found &&
    answer.expected === refs.length &&
    answer.verified === answer.expected &&
    answer.items.length === refs.length &&
    new Set(answer.items.map((item) => item.clientRef)).size === refs.length &&
    answer.items.every((item) => refs.includes(item.clientRef));
  return input.products.map((product) => {
    const item = answer.items.find((entry) => entry.clientRef === product.item.clientRef);
    // "run_not_completed" only says the ingest run is still open, which a partial run stays (completeCrawlRun is called
    // for a full run only). It is not a problem of this product (Kate Farms, 2026-10-09: all 3 were refused for it).
    const runProblems = answer.problems.filter((problem) => problem !== "run_not_completed");
    const problems = [...runProblems, ...itemProblems(item)];
    if (!exact) {
      problems.push("PRODUCT_DELIVERY.VERIFY_FAILED");
    }
    return { product, reason: problems.length ? [...new Set(problems)].join("; ") : null };
  });
}

function itemProblems(item: ProductVerifyBatchAnswer["items"][number] | undefined) {
  if (!item) {
    return ["PRODUCT_DELIVERY.VERIFY_FAILED"];
  }
  const problems = [
    ...item.problems,
    ...item.mismatches.map((mismatch) => `mismatch:${mismatch.field}`),
  ];
  if (!item.recorded || item.ledger?.status !== "ok" || !item.product || !item.listing) {
    problems.push("PRODUCT_DELIVERY.VERIFY_FAILED");
  }
  if (item.product?.identityState === "needs_review") {
    problems.push("needs_review");
  }
  return problems;
}

export function verificationExpectation({ item }: MappedDelivery) {
  return {
    clientRef: item.clientRef,
    ...(item.price === undefined ? {} : { price: item.price }),
    ...(item.currency === undefined ? {} : { currency: item.currency }),
    ...(item.inStock === undefined ? {} : { inStock: item.inStock }),
  };
}
