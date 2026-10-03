/** Validate the model's explicit per-image scope, never infer scope from a static carousel. */
export function verifyObservedGallery(base, context) {
  const gallery = base.gallery ?? [];
  const urls = gallery.map(image => image.url);
  const selected = context.galleryUrls ?? [];
  const reviews = context.galleryReview ?? [];
  const unique = values => new Set(values).size === values.length;
  if (!urls.length || !unique(urls) || !selected.length || !unique(selected)
    || selected.some(url => !urls.includes(url))) throw new Error("variant_gallery_selection_required");
  if (reviews.length !== urls.length || !unique(reviews.map(review => review.url))
    || reviews.some(review => !urls.includes(review.url))) throw new Error("variant_gallery_review_incomplete");
  for (const review of reviews) {
    if (!["applicable", "other-variant", "unresolved"].includes(review.status)
      || typeof review.reason !== "string" || !review.reason.trim()
      || !Array.isArray(review.evidence) || !review.evidence.length
      || review.evidence.some(path => typeof path !== "string" || !path.trim())) {
      throw new Error("variant_gallery_review_invalid");
    }
    if (selected.includes(review.url) !== (review.status === "applicable")) {
      throw new Error("variant_gallery_scope_conflict");
    }
    if (review.status === "applicable"
      && !["website-binding", "visual-content", "website-shared"].includes(review.basis)) {
      throw new Error("variant_gallery_scope_basis_required");
    }
    if (review.basis === "website-shared" && context.basis !== "website-shared") {
      throw new Error("variant_gallery_shared_statement_required");
    }
  }
}
