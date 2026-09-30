import { createHttpApp } from "../server.js";
import type { ApiContext } from "../trpc.js";

/** The HTTP app with only the named services; every other service is an empty stand-in that must not be called. */
export function appWith(services: Partial<Record<keyof ApiContext, object>>) {
  const unused = {} as never;
  const context = {
    runs: unused,
    queue: unused,
    brands: unused,
    reviews: unused,
    products: unused,
    originals: unused,
    history: unused,
    resources: unused,
    fleet: unused,
    listingStates: unused,
    brandScans: unused,
    brandSources: unused,
    ...services,
  } as ApiContext;
  return createHttpApp(context);
}

export const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const query = (input: unknown) => `?input=${encodeURIComponent(JSON.stringify(input))}`;
