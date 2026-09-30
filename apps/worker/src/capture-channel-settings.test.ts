import { expect, it } from "vitest";
import { CaptureChannelSettingsSchema } from "./capture-channel-settings.js";

it("always sets the fixed Whole Foods cookie and keeps it scoped to that channel", () => {
  const channels = CaptureChannelSettingsSchema.parse({
    amazon: { premium: true },
    wholefoods: { render: true, headers: { cookie: "wfm_store_d8=999" } },
  });
  expect(channels.wholefoods).toEqual({ render: true, headers: { cookie: "wfm_store_d8=10259" } });
  expect(channels.amazon).toEqual({ premium: true });
  expect(CaptureChannelSettingsSchema.parse(undefined).wholefoods.headers.cookie).toBe(
    "wfm_store_d8=10259",
  );
});
