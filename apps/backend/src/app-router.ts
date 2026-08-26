import { implement } from "@orpc/server";
import { appContract } from "@crawl-automation/contracts/app-contract";
import { buildBrowserCapturePrompt } from "@crawl-automation/runtime";
import type { PipelineRepository } from "./repository";

export function createAppRouter(repository: PipelineRepository) {
  const api = implement(appContract);
  return {
    dashboard: {
      summary: api.dashboard.summary.handler(() => repository.summary()),
    },
    classify: {
      urls: api.classify.urls.handler(({ input }) => repository.classify(input.urls)),
    },
    runs: {
      list: api.runs.list.handler(({ input }) => repository.listRuns(input.status, input.limit)),
      get: api.runs.get.handler(({ input }) => repository.getRun(input.id)),
      create: api.runs.create.handler(({ input }) => repository.createRuns(input)),
    },
    nodes: { list: api.nodes.list.handler(() => repository.listNodes()) },
    reviews: {
      list: api.reviews.list.handler(({ input }) => repository.listReviews(input.status)),
      resolve: api.reviews.resolve.handler(({ input }) => repository.resolveReview(input.id, input.action, input.resolution)),
    },
    channels: { list: api.channels.list.handler(() => repository.channelStats()) },
    debug: {
      prompt: api.debug.prompt.handler(({ input }) => ({ prompt: buildBrowserCapturePrompt({ ...input, nodeId: "debug" }) })),
    },
  };
}

