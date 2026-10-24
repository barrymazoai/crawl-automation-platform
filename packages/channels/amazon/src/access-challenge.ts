/**
 * Amazon's human-verification answers: the captcha form, the "Robot Check" page and, since round 3, the
 * "Continue shopping" interstitial (`form#checkpointForm action="/checkpoint/validate"`, page type
 * MitigationService). They answer 200 with Amazon's navigation, so only these markers tell them from a product.
 */
const CHALLENGE =
  /<form[^>]+(?:action="[^"]*(?:validateCaptcha|\/checkpoint\/)[^"]*"|id="checkpointForm")|id="captchacharacters"|<title[^>]*>[^<]*Robot Check/iu;

export const isAmazonChallenge = (html: string): boolean => CHALLENGE.test(html);
