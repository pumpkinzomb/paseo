import { googleWriteScopes } from "./write.mjs";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { googleReadScopes } from "./rest.mjs";

export class GoogleOAuthError extends Error {
  constructor(code) {
    super(code);
    this.name = "GoogleOAuthError";
    this.code = code;
  }
}

/** No socket, browser, credential storage or network side effects. */
export class GoogleOAuthAttempt {
  #clientId;
  #redirect;
  #scopes;
  #state = randomBytes(32).toString("base64url");
  #verifier = randomBytes(32).toString("base64url");
  #ended = false;
  #deadline;
  #clock;

  constructor({ clientId, redirectUri, scopes, clock = Date.now }) {
    if (
      typeof clientId !== "string" ||
      !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)
    ) {
      throw new GoogleOAuthError("INVALID_CLIENT_ID");
    }
    let redirect;
    try {
      redirect = new URL(redirectUri);
    } catch {
      throw new GoogleOAuthError("INVALID_REDIRECT");
    }
    const invalid =
      redirect.protocol !== "http:" ||
      redirect.hostname !== "127.0.0.1" ||
      !redirect.port ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash;
    if (invalid) throw new GoogleOAuthError("INVALID_REDIRECT");
    const allowed = new Set([
      ...Object.values(googleReadScopes),
      ...Object.values(googleWriteScopes),
    ]);
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope) => !allowed.has(scope))) {
      throw new GoogleOAuthError("UNSUPPORTED_SCOPE");
    }
    this.#clientId = clientId;
    this.#redirect = redirect.href;
    this.#scopes = [...new Set(scopes)];
    this.#clock = clock;
    this.#deadline = clock() + 300000;
  }

  #ensureActive() {
    if (this.#ended) throw new GoogleOAuthError("OAUTH_ATTEMPT_ENDED");
    if (this.#clock() >= this.#deadline) {
      this.cancel();
      throw new GoogleOAuthError("OAUTH_ATTEMPT_EXPIRED");
    }
  }

  authorizationUrl() {
    this.#ensureActive();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.#clientId,
      redirect_uri: this.#redirect,
      response_type: "code",
      scope: this.#scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      state: this.#state,
      code_challenge: createHash("sha256").update(this.#verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  consumeCallback(callbackUrl) {
    this.#ensureActive();
    let url;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new GoogleOAuthError("INVALID_CALLBACK");
    }
    const base = new URL(this.#redirect);
    const wrongEndpoint =
      url.origin !== base.origin ||
      url.pathname !== base.pathname ||
      url.username ||
      url.password ||
      url.hash;
    if (wrongEndpoint) throw new GoogleOAuthError("INVALID_CALLBACK");
    const states = url.searchParams.getAll("state");
    const candidate = Buffer.from(states[0] ?? "");
    const expected = Buffer.from(this.#state);
    const invalidState = states.length !== 1 || candidate.length !== expected.length;
    if (invalidState || !timingSafeEqual(candidate, expected))
      throw new GoogleOAuthError("INVALID_STATE");
    const codes = url.searchParams.getAll("code");
    if (url.searchParams.has("error")) {
      this.cancel();
      throw new GoogleOAuthError("CONSENT_NOT_COMPLETED");
    }
    if (codes.length !== 1 || !codes[0] || codes[0].length > 4096)
      throw new GoogleOAuthError("INVALID_CODE");
    const exchange = new URLSearchParams({
      grant_type: "authorization_code",
      code: codes[0],
      client_id: this.#clientId,
      redirect_uri: this.#redirect,
      code_verifier: this.#verifier,
    });
    this.cancel();
    return exchange;
  }

  cancel() {
    this.#ended = true;
    this.#verifier = "";
    this.#state = "";
  }
}
