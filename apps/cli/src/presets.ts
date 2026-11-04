/** Bundled plugins shared by init, demo and integration fixtures.
 * Optional features are installed disabled. */
export const defaultPluginNames = [
  "listener",
  "http-transport",
  "console",
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
  "subscriptions",
];

/** A fresh gateway exposes only its core product and standard protocols. */
export const defaultEnabledPluginNames = [
  "listener",
  "http-transport",
  "console",
  "auth",
  "rate-limit",
  "ai-router",
  "model-catalog",
  "observability",
  "playground",
];
