import { it, expect, vi } from "vitest";
import { createClient } from "../packages/ui-sdk/dist/index.js";
it("expires authenticated UI sessions without redirecting anonymous identity checks or invalid verification attempts", async () => {
  const expired = vi.fn();
  const client = createClient(() => {}, expired);
  const unauthorized = () =>
    Response.json(
      { error: { code: "unauthorized", message: "Authentication required" } },
      { status: 401 },
    );
  vi.stubGlobal("fetch", vi.fn().mockImplementation(unauthorized));
  try {
    await expect(
      client.request("/api/plugins/official.auth/me"),
    ).rejects.toThrow();
    expect(expired).not.toHaveBeenCalled();
    await expect(
      client.request("/api/plugins/official.auth/keys"),
    ).rejects.toThrow();
    expect(expired).toHaveBeenCalledOnce();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Response.json(
            { error: { code: "invalid_code", message: "Invalid code" } },
            { status: 401 },
          ),
        ),
    );
    await expect(
      client.request("/api/plugins/official.auth/register"),
    ).rejects.toThrow("Invalid code");
    expect(expired).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
