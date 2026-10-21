import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeJson } from "../results/result-record.js";
import { labelAnswer, signal, visionSetup } from "../testing/vision-fixture.js";
import { visionKeys, visionResponse, visionTaskFingerprint } from "./vision-files.js";

describe("publish retained vision Review answer", () => {
  it("stages a durable completion without registering a result before the recovery transaction", async () => {
    const fixture = visionSetup();
    const task = fixture.task;
    fixture.remote.data.set(
      visionKeys.intent(task),
      encodeJson({
        fingerprint: visionTaskFingerprint(task),
        nonce: randomUUID(),
        input: task.input,
      }),
    );
    fixture.remote.data.set(
      visionKeys.response(task),
      encodeJson(visionResponse(task, labelAnswer())),
    );

    const record = await fixture.results.stageReviewed(task, signal());
    expect(record.status).toBe("candidate");
    expect(fixture.remote.data.has(record.completion.objectKey)).toBe(true);
    expect(await fixture.registry.read(task.input.operationId)).toBeNull();
    expect(fixture.model.calls).toBe(0);
  });

  it("registers the existing response without calling the model and confirms lost acknowledgement", async () => {
    const fixture = visionSetup();
    const task = fixture.task;
    const answer = encodeJson(visionResponse(task, labelAnswer()));
    fixture.remote.data.set(
      visionKeys.intent(task),
      encodeJson({
        fingerprint: visionTaskFingerprint(task),
        nonce: randomUUID(),
        input: task.input,
      }),
    );
    fixture.remote.data.set(visionKeys.response(task), answer);
    fixture.registry.loseAcknowledgement = true;

    const record = await fixture.results.publishReviewed(task, signal());
    expect(record.status).toBe("candidate");
    expect(await fixture.registry.read(task.input.operationId)).toEqual(record);
    expect(fixture.remote.data.get(visionKeys.response(task))).toEqual(answer);
    expect(fixture.remote.data.has(record.completion.objectKey)).toBe(true);
    expect(fixture.model.calls).toBe(0);
  });
});
