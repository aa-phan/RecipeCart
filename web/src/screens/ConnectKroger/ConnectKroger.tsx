import { useSearchParams } from "react-router-dom";
import "./ConnectKroger.css";

// Spec 1: shown when a job is in `requires_user_intervention` state due to a
// missing/expired Kroger token. This screen is a standalone entry point —
// FailureCard.tsx deep-links here for the two kroger_* failure classes
// (web/src/lib/failureCards.ts), passing `resumeRecipeId` and `reason`.
//
// The connect link is a plain `<a>` doing a full browser navigation (NOT a
// fetch/XHR): OAuth redirects need the browser itself to follow Kroger's
// redirect chain to /api/kroger/auth/start -> Kroger's consent page ->
// /api/kroger/auth/callback, which redirects back here (with `?error=...`)
// or to `/?krogerConnected=true` on success (handled by App.tsx, which
// then routes on to this recipe's Review screen using the same
// sessionStorage key this screen writes below).
const ERROR_COPY: Record<string, string> = {
  denied: "You declined Kroger's connection request. Connect your account to continue.",
  exchange_failed:
    "Something went wrong finishing the connection to Kroger. Please try again.",
};

export default function ConnectKroger() {
  const [searchParams] = useSearchParams();
  const resumeRecipeId = searchParams.get("resumeRecipeId");
  const reason = searchParams.get("reason");
  const errorParam = searchParams.get("error");

  // The OAuth round-trip navigates away from and back to the browser, so any
  // React state would be lost. sessionStorage survives same-tab navigation,
  // letting App.tsx read this back on the `?krogerConnected=true` landing to
  // resume the right recipe (Review screen, not an auto cart-approval).
  if (resumeRecipeId) {
    sessionStorage.setItem("krogerConnectResumeRecipeId", resumeRecipeId);
  }

  const isReconnect = reason === "kroger_token_expired" || Boolean(resumeRecipeId);
  const heading = isReconnect
    ? "Your Kroger connection needs to be renewed."
    : "Connect your Kroger account to add items to your cart.";

  const errorMessage = errorParam
    ? (ERROR_COPY[errorParam] ?? "Couldn't connect your Kroger account. Please try again.")
    : undefined;

  return (
    <div className="connect-kroger">
      <p className="connect-kroger__message">{heading}</p>
      {errorMessage && (
        <p className="connect-kroger__error" role="alert">
          {errorMessage}
        </p>
      )}
      <a href="/api/kroger/auth/start" className="connect-kroger__action">
        {errorMessage ? "Try again" : isReconnect ? "Reconnect Kroger" : "Connect Kroger"}
      </a>
    </div>
  );
}
