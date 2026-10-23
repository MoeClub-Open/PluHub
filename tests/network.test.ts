import { it, expect } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";

it("does not advertise readiness before the startup graph is published", async () => {
  let release!: () => void;
  const state = globalThis as any;
  state.__pluhubStartupGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = fixture(
    ["listener", "users", "auth", "ai-router"],
    {},
    async (kernel, directory) => {
      const plugin = join(directory, "example.startup");
      await mkdir(plugin);
      await writeFile(
        join(plugin, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "example.startup",
          version: "1.0.0",
          host: ">=0.1.0-alpha.1",
          runtime: { kind: "native", entry: "index.mjs" },
          provides: [],
          requires: ["listener.address@1", "auth.admit@1", "ai.routing@2"],
          permissions: [],
        }),
      );
      await writeFile(
        join(plugin, "index.mjs"),
        "export default {async setup(h){globalThis.__pluhubStartupAddress=await h.call('listener.address@1');await globalThis.__pluhubStartupGate}};",
      );
      await kernel.add(plugin, { grants: [] });
    },
  );
  try {
    await expect
      .poll(() => state.__pluhubStartupAddress, { timeout: 5000 })
      .toBeTruthy();
    const base = "http://127.0.0.1:" + state.__pluhubStartupAddress.port;
    expect((await fetch(base + "/healthz")).status).toBe(200);
    expect((await fetch(base + "/readyz")).status).toBe(503);
    release();
    const f = await pending;
    expect((await fetch(base + "/readyz")).status).toBe(200);
    expect(await f.admin()).toHaveProperty("cookie");
  } finally {
    release();
    await (await pending).close();
    delete state.__pluhubStartupGate;
    delete state.__pluhubStartupAddress;
  }
});

it("fails readiness during drain while allowing an existing stream to finish", async () => {
  const f = await fixture(["listener", "users", "auth", "ai-router"]);
  try {
    const directory = join(f.directory, "example.drain");
    await mkdir(directory);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "example.drain",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "native", entry: "index.mjs" },
        provides: [],
        requires: [],
        permissions: ["http.route"],
      }),
    );
    await writeFile(
      join(directory, "index.mjs"),
      "export default {setup(h){h.route({method:'GET',path:'/drain',access:'public',handle:()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('start'));setTimeout(()=>{c.enqueue(new TextEncoder().encode('done'));c.close()},120)}}))})}}",
    );
    await f.kernel.add(directory, { grants: ["http.route"] });
    await f.kernel.enable("example.drain");
    const address = await f.kernel.invoke<any>("listener.address@1");
    const base = "http://127.0.0.1:" + address.port;
    expect((await fetch(base + "/readyz")).status).toBe(200);
    const response = await fetch(base + "/drain");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("start");
    const stopping = f.kernel.shutdown();
    expect((await fetch(base + "/readyz")).status).toBe(503);
    expect((await fetch(base + "/healthz")).status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("done");
    expect((await reader.read()).done).toBe(true);
    await stopping;
  } finally {
    await f.close();
  }
});

it("proxies HTTP/SSE and WebSocket with native transforms and cancellation", async () => {
  let aborted = false;
  const upstream = createServer((req, res) => {
    if (req.url === "/cancel") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.once("close", () => {
        aborted = true;
      });
    } else if (req.url === "/post") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(201, {
          "content-type": "application/octet-stream",
          "set-cookie": ["first=1; Path=/", "second=2; Path=/"],
          connection: "keep-alive, x-hop",
          "x-hop": "must-not-forward",
          "x-end-to-end": "kept",
        });
        res.end(Buffer.concat(chunks));
      });
    } else if (req.url === "/empty") {
      res.writeHead(204);
      res.end();
    } else if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: Hello\n\ndata: world\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 255]));
    }
  });
  const ws = new WebSocketServer({ server: upstream });
  ws.on("connection", (socket) =>
    socket.on("message", (data) => socket.send(data)),
  );
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const target = "http://127.0.0.1:" + (upstream.address() as any).port;
  const f = await fixture(["listener", "http-transport"]);
  try {
    const directory = join(f.directory, "example.network");
    await mkdir(directory);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "example.network",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "native", entry: "index.mjs" },
        provides: [],
        requires: ["http.transport@1"],
        permissions: ["http.route"],
      }),
    );
    await writeFile(
      join(directory, "index.mjs"),
      "export default {setup(h){h.route({method:'POST',path:'/post',access:'public',handle:(r,c)=>h.call('http.transport@1',{url:'" +
        target +
        "/post',method:'POST',headers:r.headers,body:r.body},c.signal)});for(const path of ['/binary','/sse','/cancel','/empty'])h.route({method:'GET',path,access:'public',handle:(r,c)=>h.call('http.transport@1',{url:'" +
        target +
        "'+path,method:'GET'},c.signal)});h.route({method:'GET',path:'/upper',access:'public',handle:async(r,c)=>{const response=await h.call('http.transport@1',{url:'" +
        target +
        "/sse',method:'GET'},c.signal);return new Response(response.body.pipeThrough(new TransformStream({transform(v,c){c.enqueue(new TextEncoder().encode(new TextDecoder().decode(v).toUpperCase()))}})),{headers:response.headers})}});h.upgrade('/ws','public',async()=>({url:'" +
        target +
        "/ws'}));}}",
    );
    await f.kernel.add(directory, { grants: ["http.route"] });
    await f.kernel.enable("example.network");
    const address = await f.kernel.invoke<any>("listener.address@1");
    const base = "http://127.0.0.1:" + address.port;
    const payload = Buffer.alloc(192 * 1024, 137);
    const posted = await fetch(base + "/post", {
      method: "POST",
      body: payload,
    });
    expect(posted.status).toBe(201);
    expect(posted.headers.getSetCookie()).toHaveLength(2);
    expect(posted.headers.get("x-hop")).toBeNull();
    expect(posted.headers.get("x-end-to-end")).toBe("kept");
    expect(Buffer.from(await posted.arrayBuffer())).toEqual(payload);
    const empty = await fetch(base + "/empty");
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    expect([
      ...new Uint8Array(await (await fetch(base + "/binary")).arrayBuffer()),
    ]).toEqual([0, 1, 2, 255]);
    expect(await (await fetch(base + "/sse")).text()).toBe(
      "data: Hello\n\ndata: world\n\n",
    );
    expect(await (await fetch(base + "/upper")).text()).toContain(
      "DATA: HELLO",
    );
    const socket = new WebSocket(base.replace("http:", "ws:") + "/ws");
    const echo = new Promise<string>((resolve, reject) => {
      socket.once("open", () => socket.send("hello-ws"));
      socket.once("message", (data) => resolve(data.toString()));
      socket.once("error", reject);
    });
    expect(await echo).toBe("hello-ws");
    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const cancel = new AbortController();
    const response = await fetch(base + "/cancel", { signal: cancel.signal });
    await response.body!.getReader().read();
    cancel.abort();
    await expect.poll(() => aborted, { timeout: 2000 }).toBe(true);
  } finally {
    await f.close();
    ws.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it("honors an explicit public origin behind TLS termination for authenticated mutations", async () => {
  const f = await fixture(["listener", "users", "auth"]);
  try {
    await f.admin();
    await f.kernel.shutdown();
    f.kernel.configure({
      "official.listener": {
        port: 0,
        host: "127.0.0.1",
        publicOrigin: "https://gateway.example",
      },
      "official.auth": { secureCookie: true },
    });
    await f.kernel.start();
    const address = await f.kernel.invoke<any>("listener.address@1");
    const base = "http://127.0.0.1:" + address.port;
    const login = await fetch(base + "/api/plugins/official.auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://gateway.example",
      },
      body: JSON.stringify({
        username: "admin",
        password: "correct-admin-password",
      }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain("Secure");
    await login.json();
    const cookie = setCookie.split(";")[0]!;
    const key = await fetch(base + "/api/plugins/official.auth/keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://gateway.example",
      },
      body: JSON.stringify({ name: "proxy-test" }),
    });
    expect(key.status).toBe(201);
    await key.json();
    const denied = await fetch(base + "/api/plugins/official.auth/keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://other.example",
      },
      body: '{"name":"denied"}',
    });
    expect(denied.status).toBe(403);
    await denied.json();
  } finally {
    await f.close();
  }
});
