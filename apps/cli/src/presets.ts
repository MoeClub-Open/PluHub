/** Bundled plugins shared by init, demo and integration fixtures.
 * Optional features are installed disabled; compatibility adapters stay opt-in. */
export const defaultPluginNames = [
  "listener",
  "http-transport",
  "console",
  "users",
  "auth",
  "ai-router",
  "model-catalog",
  "observability",
  "leaderboard",
  "playground",
  "billing",
  "commerce",
  "payments-stripe",
  "payments-epay",
  "byok",
  "rate-limit",
  "auto-router",
  "token-speed",
  "tickets",
  "mailer",
  "turnstile",
  "upstream-codex",
  "upstream-claude-subscription",
  "upstream-antigravity",
  "ingress-openai-media",
  "upstream-openai-media",
  ...["openai-chat", "openai-responses", "anthropic", "gemini"].flatMap(
    (protocol) => ["ingress-" + protocol, "upstream-" + protocol],
  ),
];

/** A fresh gateway exposes only its core product and standard protocols. */
export const defaultEnabledPluginNames = [
  "listener",
  "http-transport",
  "console",
  "users",
  "auth",
  "ai-router",
  "model-catalog",
  "observability",
  "playground",
  ...["openai-chat", "openai-responses", "anthropic", "gemini"].flatMap(
    (protocol) => ["ingress-" + protocol, "upstream-" + protocol],
  ),
];
