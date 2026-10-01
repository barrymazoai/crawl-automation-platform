import { CommerceEvidenceSchema } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { amazonCommerce } from "./commerce.js";
import { amazonDocument, productRoot } from "./dom.js";

const asin = "B0013LAQS6";
const price = (value: string) =>
  `<span class="a-price priceToPay"><span class="a-offscreen">$${value}</span></span>`;
function read(body: string, header = "") {
  const document = amazonDocument(`<html><body>${header}<div id="ppd">
    <input id="ASIN" value="${asin}">${body}</div></body></html>`);
  return CommerceEvidenceSchema.parse(amazonCommerce(productRoot(document), asin));
}

describe("Amazon retained commerce (synthetic)", () => {
  it.each([
    {
      text: "1K+ bought in past month",
      lowerBound: "1000",
      period: "past_month",
      approximate: true,
    },
    {
      text: "1.5K+ bought in the past month",
      lowerBound: "1500",
      period: "past_month",
      approximate: true,
    },
    { text: "200+ bought in past week", lowerBound: "200", period: "past_week", approximate: true },
    {
      text: "1,200 bought in past month",
      lowerBound: "1200",
      period: "past_month",
      approximate: false,
    },
  ])("keeps the qualifier and period of $text", ({ text, lowerBound, period, approximate }) => {
    expect(
      read(`<div id="socialProofingAsinFaceout_feature_div">${text}</div>`).salesVolume,
    ).toMatchObject({ text, lowerBound, period, approximate });
  });

  it.each(["0 bought in past month", "1.5 bought in past week", "popular", "1K bought last year"])(
    "does not invent a sales count from %s",
    (text) => {
      expect(
        read(`<div id="socialProofingAsinFaceout_feature_div">${text}</div>`).salesVolume,
      ).toBeNull();
    },
  );

  it("ignores hidden and recommended sales claims", () => {
    const badge = '<div id="socialProofingAsinFaceout_feature_div">9K+ bought in past month</div>';
    expect(
      read(`<div hidden>${badge}</div><div id="recommendations">${badge}</div>`).salesVolume,
    ).toBeNull();
  });

  it("removes hidden descendants of the public badge before reading its claim", () => {
    expect(
      read(
        '<div id="socialProofingAsinFaceout_feature_div">1K+ bought in past month' +
          "<span hidden>9K+ bought in past month</span></div>",
      ).salesVolume?.lowerBound,
    ).toBe("1000");
  });

  it.each([
    ["See All Buying Options", "buying_options"],
    ["To see product details, add this item to your cart", "cart_required"],
  ])("retains the price status: %s", (copy, status) => {
    expect(read(`<div id="buybox">${copy}</div>`)).toMatchObject({
      price: null,
      priceStatus: status,
    });
  });

  it("binds purchase terms and coupon observations to the selected offer", () => {
    const result = read(
      `<div id="corePriceDisplay_desktop_feature_div">${price("20.00")}</div>
      <div id="buyBoxAccordion">
        <div class="a-box"><div id="couponsInBuybox_feature_div">Save 90% coupon</div></div>
        <div class="a-box a-accordion-active">One-time purchase
          <div id="corePrice_feature_div">${price("20.00")}</div>
          <div class="tabular-buybox-text">Ships from</div><div>Amazon.com</div>
          <a id="sellerProfileTriggerId" href="/sp?seller=SELLER123&session=private">Acme</a>
          <select name="quantity"><option value="1">1</option><option selected value="2">2</option></select>
          <div id="couponsInBuybox_feature_div">Save 10% coupon on your first order
            <input type="checkbox" checked>
          </div>
        </div>
      </div><div id="variation_size_name"><span class="a-form-label">Size:</span>
        <span class="selection">60 Capsules</span></div>`,
      '<a id="nav-global-location-popover-link">Delivering to Buffalo 14205</a>',
    );
    expect(result.purchaseConditions).toMatchObject({
      purchaseType: "one_time",
      priceScope: "selected_offer",
      quantity: 2,
      seller: { name: "Acme", id: "SELLER123", url: "https://www.amazon.com/sp?seller=SELLER123" },
      shipsFrom: "Amazon.com",
      delivery: { text: "Delivering to Buffalo 14205", postalCode: "14205", countryCode: null },
      selectedOptions: [{ name: "Size:", value: "60 Capsules" }],
      promotions: [{ type: "coupon", percent: "10", amount: null, applied: null }],
    });
    expect(result.context.join(" ")).toContain("selected offer:");
    expect(result.price).toBe("20.00");
  });

  it("keeps subscription frequency and does not calculate a coupon-adjusted price", () => {
    const result = read(`<div id="buyBoxAccordion"><div class="a-box a-accordion-active">
      Subscribe &amp; Save<div id="corePrice_feature_div">${price("18.00")}</div>
      <select name="frequency"><option selected>Every 2 months</option></select>
      <div id="coupons_feature_div">Save $2 coupon. Coupon applied</div>
    </div></div>`);
    expect(result.price).toBe("18.00");
    expect(result.purchaseConditions).toMatchObject({
      purchaseType: "subscription",
      subscription: { frequencyText: "Every 2 months" },
      promotions: [{ type: "coupon", amount: "2", applied: true }],
    });
  });

  it("does not select between multiple active offers or infer a purchase type from Add to cart", () => {
    const result = read(`<div id="buyBoxAccordion">
      <div class="a-accordion-active">One-time purchase ${price("20.00")}</div>
      <div class="a-accordion-active">Subscribe &amp; Save ${price("18.00")}</div></div>`);
    expect(result.purchaseConditions?.purchaseType).toBe("unknown");
    expect(read('<div id="buybox">Add to cart</div>').purchaseConditions?.purchaseType).toBe(
      "unknown",
    );
  });

  it("preserves conflicting main prices as ambiguous and hidden terms as absent", () => {
    const result =
      read(`<div id="corePriceDisplay_desktop_feature_div">${price("20.00")}${price("30.00")}</div>
      <div hidden id="coupons_feature_div">Save 50% coupon</div>`);
    expect(result).toMatchObject({ price: null, priceStatus: "ambiguous" });
    expect(result.purchaseConditions?.promotions).toEqual([]);
  });
});
