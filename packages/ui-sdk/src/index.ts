export interface Extension {
  id: string;
  title: string;
  path: string;
  url: string;
  public?: boolean;
  group?: string;
  order?: number;
}
export interface UIHost {
  i18n?: UIInternationalization;
  /** Display hint only; all API access is still authorized by the host. */
  authenticated?: boolean;
  slot?: string;
  /** Current extension page path, including additional manifest UI pages. */
  page?: string;
  request<T = any>(path: string, init?: RequestInit): Promise<T>;
  navigate(path: string): void;
  refresh(): void;
}
export interface UIExtensionModule {
  mount(element: HTMLElement, host: UIHost): () => void;
}
export function createClient(
  refresh: () => void = () => {},
  sessionExpired?: () => void,
  i18n?: UIInternationalization,
  confirmIdentity?: () => Promise<void>,
): UIHost {
  return {
    i18n,
    async request<T>(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (init.body) headers.set("content-type", "application/json");
      const send = () =>
        fetch(path, { ...init, headers, credentials: "same-origin" });
      let r = await send();
      let data = await r.json();
      if (
        r.status === 403 &&
        data.error?.code === "reauth_required" &&
        !["GET", "HEAD", "OPTIONS"].includes(
          (init.method ?? "GET").toUpperCase(),
        ) &&
        confirmIdentity
      ) {
        await confirmIdentity();
        init.signal?.throwIfAborted();
        r = await send();
        data = await r.json();
      }
      if (!r.ok) {
        if (
          r.status === 401 &&
          data.error?.code === "unauthorized" &&
          path !== "/api/plugins/official.auth/me"
        )
          sessionExpired?.();
        const message = data.error?.message ?? "请求失败";
        throw new Error(i18n?.t(message) ?? message);
      }
      return data as T;
    },
    navigate(path) {
      location.hash = path;
    },
    refresh,
  };
}

export interface SlotContribution {
  id: string;
  slot: string;
  url: string;
}
export async function mountSlot(
  element: HTMLElement,
  name: string,
  host: UIHost,
): Promise<() => void> {
  const contributions = (
    await host.request<SlotContribution[]>("/api/host/slots")
  )
    .filter((c) => c.slot === name)
    .sort((a, b) => a.id.localeCompare(b.id));
  const cleanups: (() => void)[] = [];
  await Promise.all(
    contributions.map(async (contribution) => {
      const container = document.createElement("div");
      element.appendChild(container);
      cleanups.push(() => container.remove());
      try {
        const mod = (await import(contribution.url)) as UIExtensionModule;
        cleanups.push(mod.mount(container, { ...host, slot: name }));
      } catch {
        container.textContent = host.i18n
          ? host.i18n.t("扩展加载失败：{id}", { id: contribution.id })
          : "扩展加载失败：" + contribution.id;
      }
    }),
  );
  return () => {
    for (const cleanup of cleanups.reverse())
      try {
        cleanup();
      } catch {
        console.warn("Slot extension cleanup failed");
      }
  };
}
import type { UIInternationalization } from "./i18n.js";
export * from "./i18n.js";
