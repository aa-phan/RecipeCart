// Tiny local HTTP server for the P1 CLI OAuth2 callback (Spec 3 §2.4 — "the
// redirect URI just needs to point at the deployed web app's real URL" in
// P4; here it points at localhost). Listens only long enough to catch the
// one redirect from Kroger's consent page, then shuts down.
import http from "node:http";
import { config } from "../platform/config.js";

export interface CallbackResult {
  code: string;
  state: string;
}

/** Starts a one-shot HTTP server on the port from KROGER_REDIRECT_URI,
 * resolves with the ?code&state query params from the first request that
 * hits the callback path, then closes the server. */
export function waitForCallback(): Promise<CallbackResult> {
  const redirectUrl = new URL(config.krogerRedirectUri);
  const port = Number(redirectUrl.port || 80);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname !== redirectUrl.pathname) {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res
          .writeHead(400, { "Content-Type": "text/html" })
          .end(`<html><body>Authorization failed: ${error}. You can close this tab.</body></html>`);
        server.close();
        reject(new Error(`Kroger authorization error: ${error}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400).end("Missing code/state");
        return;
      }

      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<html><body>Connected to Kroger — you can close this tab.</body></html>");
      server.close();
      resolve({ code, state });
    });

    server.on("error", reject);
    server.listen(port);
  });
}
