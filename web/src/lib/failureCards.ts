// Lookup from FailureClass (mirrors src/pipeline/extract/failures.ts's
// FailureClass union) to a plain-language failure card: one message + one
// recovery action, per Spec 1 §16. Extended with a couple of
// operationally-relevant non-extraction classes (Kroger connect/expiry, cart
// partial failure, automation outage) so the same lookup can back
// FailureCard.tsx across the app, not just extraction failures.

export type FailureClass =
  | "download_failed_permanent"
  | "download_failed_transient"
  | "model_call_failed"
  | "schema_validation_failed"
  | "extraction_timeout"
  | "not_a_recipe"
  | "kroger_not_connected"
  | "kroger_token_expired"
  | "cart_partially_failed"
  | "automation_unavailable";

export interface FailureCard {
  message: string;
  recoveryAction: string;
  /** When present, the recovery action is a plain navigation link built from
   * this recipe's id (e.g. into `/connect-kroger`) instead of the default
   * reprocess-POST action — see FailureCard.tsx, which renders a `<Link>`
   * for these two kroger cards and a reprocess `<button>` for every other
   * card. */
  recoveryHref?: (recipeId: string) => string;
}

const FAILURE_CARDS: Record<FailureClass, FailureCard> = {
  download_failed_permanent: {
    message:
      "This video couldn't be downloaded — it may be private, deleted, or region-restricted.",
    recoveryAction: "Try a different link.",
  },
  download_failed_transient: {
    message: "Downloading this video kept failing (network or TikTok-side issue).",
    recoveryAction: "Retry.",
  },
  model_call_failed: {
    message: "Extracting the recipe failed.",
    recoveryAction: "Retry.",
  },
  schema_validation_failed: {
    message: "The recipe couldn't be structured reliably from this video.",
    recoveryAction: "Retry, or edit the ingredients manually.",
  },
  extraction_timeout: {
    message: "This recipe took too long to process.",
    recoveryAction: "Retry.",
  },
  not_a_recipe: {
    // Deliberately distinct from every other card (Spec C2 §26): this must
    // not read as "a garbled recipe or a generic error" — the video was
    // successfully processed, it just isn't a recipe. There's nothing to
    // reprocess or reconnect, so the primary action just navigates home
    // (recoveryHref, not the default reprocess-POST button) rather than
    // offering a retry that would only reach the same conclusion.
    message: "This doesn't look like a recipe video.",
    recoveryAction: "Back to recipes",
    recoveryHref: () => "/",
  },
  kroger_not_connected: {
    message: "Your Kroger account isn't connected yet.",
    recoveryAction: "Connect your Kroger account to add items to a cart.",
    recoveryHref: (recipeId) =>
      `/connect-kroger?resumeRecipeId=${recipeId}&reason=kroger_not_connected`,
  },
  kroger_token_expired: {
    message: "Your Kroger connection has expired.",
    recoveryAction: "Reconnect your Kroger account.",
    recoveryHref: (recipeId) =>
      `/connect-kroger?resumeRecipeId=${recipeId}&reason=kroger_token_expired`,
  },
  cart_partially_failed: {
    message: "Some items couldn't be added to your cart.",
    recoveryAction: "Review the itemized list — the rest of your cart is unaffected.",
  },
  automation_unavailable: {
    message: "Adding items to your cart is temporarily unavailable.",
    recoveryAction: "Your recipe is saved — try adding to cart again later.",
  },
};

const FALLBACK_CARD: FailureCard = {
  message: "Something went wrong.",
  recoveryAction: "Try again, or come back later.",
};

export function failureCardFor(failureClass: string | undefined): FailureCard {
  if (!failureClass) return FALLBACK_CARD;
  return FAILURE_CARDS[failureClass as FailureClass] ?? FALLBACK_CARD;
}
