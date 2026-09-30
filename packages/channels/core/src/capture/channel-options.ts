import type { ScraperApiOptions } from "@crawl-automation/platform";

/** Some channel options; absent values retain public defaults, never another channel's headers. */
export type ChannelOptions = {
  [Name in keyof ScraperApiOptions]?: ScraperApiOptions[Name] | undefined;
};

export function channelOptions(
  defaults: ScraperApiOptions,
  own: ChannelOptions = {},
): ScraperApiOptions {
  const { headers: _headers, ...publicDefaults } = defaults;
  const given = Object.entries(own).filter(([, value]) => value !== undefined);
  return { ...publicDefaults, ...Object.fromEntries(given) };
}
