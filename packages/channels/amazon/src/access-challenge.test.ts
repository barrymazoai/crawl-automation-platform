import { describe, expect, it } from "vitest";
import { isAmazonChallenge } from "./access-challenge.js";
import { amazonDocument } from "./dom.js";

// Markup of the interstitial Amazon served on 2026-10-24 (B00SBZ2FFE, 291 KB page), trimmed to its form.
const interstitial = `<html><head></head><body><div id="nav-link-accountList"><a href="/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fcheckpoint%2Fcontinue">Sign in</a></div>
<h4 role="heading" aria-level="1">To continue, please click the "Continue shopping" button below.</h4>
<form method="POST" action="/checkpoint/validate" id="checkpointForm"><input type="hidden" name="token" value="v1.x">
<button type="submit" class="a-button-text" name="continueClick" value="true">Continue shopping</button></form></body></html>`;

describe("Amazon human verification", () => {
  it.each([
    ["the Continue shopping interstitial", interstitial],
    ["the captcha form", '<form method="get" action="/errors/validateCaptcha"></form>'],
    ["the captcha field", '<input id="captchacharacters" name="field-keywords">'],
    ["the Robot Check page", "<html><head><title>Robot Check</title></head></html>"],
  ])("recognises %s and refuses it as a page", (_name, html) => {
    expect(isAmazonChallenge(html)).toBe(true);
    expect(() => amazonDocument(html)).toThrow(
      expect.objectContaining({ code: "CAPTURE.ACCESS_CHALLENGE" }),
    );
  });

  it("does not take a product page's sign-in links to /checkpoint/continue for verification", () => {
    const product = `<html><body><a href="/ap/signin?openid.return_to=%2Fcheckpoint%2Fcontinue">x</a><div id="ppd"></div></body></html>`;
    expect(isAmazonChallenge(product)).toBe(false);
  });
});
