import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

function offlineShellPlugin(): Plugin {
  return {
    name: "offline-shell",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((name) => name !== "sw.js").sort();
    const versionInputs: Array<readonly [string, string]> = assets.map((name) => {
        const item = bundle[name];
        return [name, item.type === "asset" ? String(item.source) : item.code];
    });
    versionInputs.push(["index.html", readFileSync("index.html", "utf8")]);
    const version = createHash("sha256").update(JSON.stringify(versionInputs)).digest("hex").slice(0, 16);
      const assetJson = JSON.stringify(["index.html", ...assets]);
      const source = `const CACHE_NAME = "shogi-review-shell-${version}";
const BASE = self.location.pathname.slice(0, -5);
const APP_ROOT = new URL(".", self.location.origin + BASE).href;
const SHELL = new URL("index.html", self.location.origin + BASE).href;
const ASSETS = ${assetJson}.map((asset) => new URL(asset, self.location.origin + BASE).href);
const KILL_SWITCH = false;
const PRIVATE_PATHS = ["/auth", "/rest/v1", "/rpc", "/functions/v1", "/storage/v1", "/oauth"];

self.addEventListener("install", (event) => {
  if (KILL_SWITCH) return;
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([APP_ROOT, ...ASSETS])));
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (KILL_SWITCH) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("shogi-review-shell-")).map((key) => caches.delete(key)));
      await self.registration.unregister();
      return;
    }
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("shogi-review-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || request.headers.has("range") || PRIVATE_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(path + "/"))) return;
  const isAsset = ASSETS.includes(url.href);
  if (request.mode === "navigate") {
    if (url.search) return;
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    }).catch(() => caches.match(request).then((cached) => cached ?? caches.match(SHELL).then((shell) => shell ?? Response.error()))));
  } else if (isAsset) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
  }
});
`;
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  base: "/shogi-review/",
  plugins: [offlineShellPlugin()],
});
