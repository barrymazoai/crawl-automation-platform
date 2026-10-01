import { expect, it } from "vitest";
import { WHOLE_FOODS_STORE, wholeFoodsStoreCookie } from "@crawl-automation/channels-wholefoods";
import { CaptureChannelSettingsSchema } from "./capture-channel-settings.js";

const storeCookie = wholeFoodsStoreCookie(WHOLE_FOODS_STORE);

it("always sets the fixed Whole Foods cookie and keeps it scoped to that channel", () => {
  const channels = CaptureChannelSettingsSchema.parse({
    amazon: { premium: true },
    wholefoods: { render: true, headers: { cookie: "wfm_store_d8=999" } },
  });
  expect(channels.wholefoods).toEqual({ render: true, headers: { cookie: storeCookie } });
  expect(channels.amazon).toEqual({ premium: true });
  expect(CaptureChannelSettingsSchema.parse(undefined).wholefoods.headers.cookie).toBe(storeCookie);
});

it("fetches Costco raw product HTML by default and accepts explicit provider overrides", () => {
  expect(CaptureChannelSettingsSchema.parse(undefined).costco).toEqual({ render: false });
  expect(CaptureChannelSettingsSchema.parse({ costco: { premium: true } }).costco).toEqual({
    render: false,
    premium: true,
  });
});
