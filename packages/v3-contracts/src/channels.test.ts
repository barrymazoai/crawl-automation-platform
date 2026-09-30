import { describe, expect, it } from "vitest";
import { Channel } from "./brands.js";
import { CHANNEL_IDS, ChannelIdSchema } from "./channels.js";

describe("channel list", () => {
  it("is the one list: brand sources accept every channel", () => {
    for (const channel of CHANNEL_IDS) expect(Channel.parse(channel)).toBe(channel);
    expect(ChannelIdSchema.safeParse("walmart").success).toBe(false);
  });
});
