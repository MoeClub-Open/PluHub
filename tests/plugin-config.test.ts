import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createClient } from "../packages/ui-sdk/dist/index.js";
import { fixture } from "./helpers.js";

it("saves Stripe configuration through a proxy without revision headers and rejects stale writes", async () => {
  const f = await fixture([
    "auth",
    "http-transport",
    "billing",
    "commerce",
    "payments-stripe",
  ]);
  let proxy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const admin = await f.admin();
    proxy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", admin.cookie);
        const response = await f.kernel.fetch(
          new Request(new URL(String(input), "http://localhost"), {
            ...init,
            headers,
          }),
        );
        const forwarded = new Headers(response.headers);
        forwarded.delete("etag");
        forwarded.delete("last-modified");
        return new Response(response.body, {
          status: response.status,
          headers: forwarded,
        });
      });
    const client = createClient();
    const before = await client.pluginConfig("official.payments-stripe");
    expect(before.revision).toBeTruthy();

    const stored = await f.request(
      "/api/plugins/official.payments-stripe/secrets",
      "POST",
      {
        keyRef: "sk_test_configuration_fixture",
        webhookSecretRef: "whsec_configuration_fixture",
      },
      admin,
    );
    expect(stored.status).toBe(200);
    const refs = await stored.json();
    const settings = { ...refs, enabled: true, livemode: false };
    const saved = await client.savePluginConfig(
      "official.payments-stripe",
      settings,
      before.revision,
    );
    expect(saved.config).toEqual(settings);
    expect(saved.revision).not.toBe(before.revision);
    expect(await client.pluginConfig("official.payments-stripe")).toEqual({
      config: settings,
      revision: saved.revision,
    });

    await expect(
      client.savePluginConfig(
        "official.payments-stripe",
        { ...settings, enabled: false },
        before.revision,
      ),
    ).rejects.toThrow("配置已更新");
    const missingRevision = await f.request(
      "/api/host/plugins/official.payments-stripe/config",
      "PUT",
      { config: settings },
      admin,
    );
    expect(missingRevision.status).toBe(409);
    await missingRevision.json();
    const disk = JSON.parse(await readFile(f.file, "utf8"));
    expect(
      disk.plugins.find((p: any) => p.path.endsWith("payments-stripe")).config,
    ).toEqual(settings);
    expect(JSON.stringify(disk)).not.toContain("sk_test_configuration_fixture");
    expect(JSON.stringify(disk)).not.toContain("whsec_configuration_fixture");
  } finally {
    proxy?.mockRestore();
    await f.close();
  }
});
