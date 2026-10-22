import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { createKernel } from "../packages/control/dist/index.js";

it("records a recovered setup intent only when it actually creates the administrator password", async () => {
  const f = await fixture(["users", "auth"]);
  const db = new DatabaseSync(
    join(f.config.dataDir, "official.auth", "auth.sqlite"),
  );
  try {
    await f.admin();
    const owner = await f.kernel.invoke<any>("users.lookup@1", {
      username: "admin",
    });
    const password = db
      .prepare("SELECT hash FROM passwords WHERE user_id=?")
      .get(owner.id)!.hash;
    await f.kernel.shutdown();
    db.prepare("INSERT INTO setup_admin VALUES(?,?,?)").run(
      owner.id,
      owner.username,
      password,
    );
    db.prepare("DELETE FROM passwords WHERE user_id=?").run(owner.id);
    db.exec("DELETE FROM security_events;");
    let kernel = await createKernel(f.config);
    await kernel.start();
    await kernel.shutdown();
    expect(
      db.prepare("SELECT action,user_id,method FROM security_events").all(),
    ).toEqual([
      { action: "account.bootstrap", user_id: owner.id, method: "internal" },
    ]);
    db.prepare("INSERT INTO setup_admin VALUES(?,?,?)").run(
      owner.id,
      owner.username,
      password,
    );
    kernel = await createKernel(f.config);
    await kernel.start();
    await kernel.shutdown();
    expect(db.prepare("SELECT count(*) n FROM security_events").get()!.n).toBe(
      1,
    );
    expect(db.prepare("SELECT count(*) n FROM setup_admin").get()!.n).toBe(0);
  } finally {
    db.close();
    await f.close();
  }
});
