import { it, expect } from "vitest";
import { fixture } from "./helpers.js";

it("provisions a usable account in one session request and rejects invalid passwords before creating user facts", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const admin = await f.admin();
    const path = "/api/plugins/official.auth/users";
    const rejected = await f.request(
      path,
      "POST",
      { username: "invalid-password", password: "short" },
      admin,
    );
    expect(rejected.status).toBe(400);
    await rejected.text();
    expect(
      await f.kernel.invoke("users.lookup@1", { username: "invalid-password" }),
    ).toBeUndefined();
    const created = await f.request(
      path,
      "POST",
      { username: "ready-user", password: "ready-user-password", role: "user" },
      admin,
    );
    expect(created.status).toBe(201);
    const user = await created.json();
    expect(user).toMatchObject({
      username: "ready-user",
      role: "user",
      enabled: true,
    });
    expect(Object.keys(user)).not.toContain("hash");
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: "ready-user",
      password: "ready-user-password",
    });
    expect(login.status).toBe(200);
    await login.text();
    const ordinary = {
      cookie: login.headers.get("set-cookie")!.split(";")[0]!,
    };
    const unauthorized = await f.request(
      path,
      "POST",
      {
        username: "rogue-admin",
        password: "some-valid-password",
        role: "admin",
      },
      ordinary,
    );
    expect(unauthorized.status).toBe(403);
    await unauthorized.text();
    expect(
      await f.kernel.invoke("users.lookup@1", { username: "rogue-admin" }),
    ).toBeUndefined();
    const key = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        { name: "admin-gateway-key" },
        admin,
      )
    ).json();
    const deniedKey = await f.request(
      path,
      "POST",
      { username: "key-created", password: "some-valid-password" },
      { authorization: "Bearer " + key.token },
    );
    expect(deniedKey.status).toBe(403);
    await deniedKey.text();
    const duplicate = await f.request(
      path,
      "POST",
      { username: "ready-user", password: "ready-user-password" },
      admin,
    );
    expect(duplicate.status).toBe(409);
    await duplicate.text();
  } finally {
    await f.close();
  }
});

it("rejects unavailable payment methods and incompatible currencies before recording an order", async () => {
  process.env.PLUHUB_CHECKOUT_TEST_SECRET = "local-md5-test-secret";
  const product = {
    id: "credit-usd",
    name: "Credit",
    currency: "usd",
    mode: "payment",
    paymentMinor: 500,
    creditMicros: 5000000,
  };
  const f = await fixture(
    [
      "http-transport",
      "users",
      "auth",
      "billing",
      "commerce",
      "payments-stripe",
      "payments-epay",
    ],
    {
      commerce: {
        publicUrl: "http://localhost",
        products: [product, { ...product, id: "credit-cny", currency: "cny" }],
      },
      "payments-epay": {
        enabled: true,
        version: "v1",
        algorithm: "MD5",
        pid: "test",
        baseUrl: "https://payment.example.test",
        publicUrl: "http://localhost",
        keyRef: "env:PLUHUB_CHECKOUT_TEST_SECRET",
        secretRefs: ["env:PLUHUB_CHECKOUT_TEST_SECRET"],
      },
    },
  );
  try {
    const admin = await f.admin();
    const api = "/api/plugins/official.commerce";
    const catalog = await (
      await f.request(api + "/catalog", "GET", undefined, admin)
    ).json();
    expect(
      catalog.paymentMethods.map((method: any) => method.provider),
    ).toContain("epay");
    for (const [provider, status] of [
      ["stripe", 409],
      ["epay", 400],
      ["unknown", 400],
    ] as const) {
      const result = await f.request(
        api + "/checkout",
        "POST",
        { productId: "credit-usd", provider },
        admin,
      );
      expect(result.status).toBe(status);
      await result.text();
    }
    expect(
      await (await f.request(api + "/orders", "GET", undefined, admin)).json(),
    ).toEqual([]);
    const valid = await f.request(
      api + "/checkout",
      "POST",
      { productId: "credit-cny", provider: "epay" },
      admin,
    );
    expect(valid.status).toBe(200);
    expect((await valid.json()).url).toMatch(
      /^https:\/\/payment\.example\.test\/submit.php/,
    );
    expect(
      await (await f.request(api + "/orders", "GET", undefined, admin)).json(),
    ).toHaveLength(1);
  } finally {
    await f.close();
    delete process.env.PLUHUB_CHECKOUT_TEST_SECRET;
  }
});
