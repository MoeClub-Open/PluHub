import { expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pluginsRoot } from "./helpers.js";

it("exports the shared browser runtime used by every extension", async () => {
  const load = (name: string) =>
    import(pathToFileURL(join(pluginsRoot, "console/dist", name)).href);
  const [react, jsx, dom, client, sdk] = await Promise.all([
    load("vendor-react.js"),
    load("vendor-jsx-runtime.js"),
    load("vendor-react-dom.js"),
    load("vendor-react-dom-client.js"),
    load("vendor-ui-sdk.js"),
  ]);
  expect(typeof jsx.jsx).toBe("function");
  expect(typeof jsx.jsxs).toBe("function");
  expect(react.isValidElement(jsx.jsx("span", { children: "ready" }))).toBe(
    true,
  );
  expect(react.default.useState).toBe(react.useState);
  expect(typeof dom.createPortal).toBe("function");
  expect(typeof client.createRoot).toBe("function");
  expect(typeof sdk.createClient().pluginConfig).toBe("function");
  expect(typeof sdk.createClient().savePluginConfig).toBe("function");
});
