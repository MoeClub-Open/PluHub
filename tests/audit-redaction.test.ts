import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditStore } from "../packages/control/dist/audit.js";
import { createLogSanitizer } from "../packages/kernel/dist/logging.js";
import { fixture } from "./helpers.js";

it("redacts audit fields before truncation and persistence, and masks legacy reads without rewriting the original", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-audit-privacy-"));
  const redact = createLogSanitizer();
  const store = auditStore(directory, redact.text);
  redact.register("dynamic-private-value");
  const privateValue =
    'ph_abcdefghijklmnop password="password with spaces" dynamic-private-value -----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----';
  try {
    store.write({
      id: "new",
      createdAt: Date.now(),
      actorId: privateValue,
      method: "POST",
      path: "/" + privateValue,
      userId: privateValue,
      resourceId: privateValue,
      reason: "x".repeat(240) + privateValue,
      errorCode: privateValue,
      status: 200,
    });
    const db = new DatabaseSync(join(directory, "admin-audit.sqlite"));
    try {
      const stored = JSON.stringify(
        db.prepare("SELECT * FROM admin_audit").all(),
      );
      for (const secret of [
        "ph_",
        "password with spaces",
        "dynamic-private-value",
        "private-key-body",
      ])
        expect(stored).not.toContain(secret);
      db.prepare(
        "INSERT INTO admin_audit(id,created_at,actor_id,method,path,reason) VALUES('legacy',?,'admin','POST','/legacy',?)",
      ).run(Date.now(), privateValue);
      const read = JSON.stringify(
        store.read(new URLSearchParams("requestId=legacy")).items,
      );
      for (const secret of [
        "ph_",
        "password with spaces",
        "dynamic-private-value",
        "private-key-body",
      ])
        expect(read).not.toContain(secret);
      expect(
        db.prepare("SELECT reason FROM admin_audit WHERE id='legacy'").get()!
          .reason,
      ).toBe(privateValue);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("applies the kernel secret scrubber to administrator operation reasons before truncation", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const admin = await f.admin();
    const user = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "audit-redaction",
    });
    const secret = "ph_private_admin_reason_123456";
    const response = await f.request(
      "/api/plugins/official.auth/password",
      "POST",
      {
        userId: user.id,
        password: "new-admin-password",
        reason: "x".repeat(250) + secret,
      },
      admin,
    );
    expect(response.status).toBe(200);
    const db = new DatabaseSync(join(f.config.dataDir, "admin-audit.sqlite"));
    try {
      const row = db
        .prepare("SELECT reason FROM admin_audit WHERE id=?")
        .get(response.headers.get("x-pluhub-request-id"))!;
      expect(row.reason).not.toContain("ph_");
      expect(String(row.reason).length).toBeLessThanOrEqual(256);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
