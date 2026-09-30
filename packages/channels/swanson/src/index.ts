export { swansonAdapter } from "./adapter.js";
export { extractSwansonLabelCore, swansonLabelCore } from "./label-core.js";
export { SWANSON_HTTP_POLICY } from "./adapter.js";
export { swansonProductAddress, swansonUrl, SWANSON_ORIGIN } from "./swanson-address.js";
export { swansonErrors } from "./swanson-errors.js";
export { parseSwansonRenderedProduct } from "./swanson-evidence.js";
export { swansonVariantChoices } from "./swanson-variants.js";
export { parseSwansonStaticHtml } from "./swanson-static-html.js";
export { swansonPipelineFixture } from "./testing/pipeline-fixture.js";
export { createSwansonAdapter } from "./configured-adapter.js";
export { createSwansonBrandScan } from "./brand-scan.js";
export {
  SwansonBrandScanSettingsSchema,
  type SwansonBrandScanSettings,
} from "./brand-scan-settings.js";
