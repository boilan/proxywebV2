importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const engine = new ScramjetServiceWorker();

// Eagerly initialize the engine configuration and rewriter wasm
engine.loadConfig().catch((e) => console.warn("[Omnitab SW] Eager loadConfig notice:", e));

self.addEventListener("install", (event) => {
	// Keep the SW alive until the config/wasm is available: without waitUntil the
	// worker can be killed mid-initialization and the first proxied request then
	// falls back to the plain network.
	event.waitUntil(
		(async () => {
			try {
				await engine.loadConfig();
			} catch (err) {
				console.warn("[Omnitab SW] loadConfig during install failed:", err);
			}
			await self.skipWaiting();
		})()
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		Promise.all([self.clients.claim(), engine.loadConfig()])
	);
});

async function handleRequest(event) {
	try {
		await engine.loadConfig();
		if (engine.route(event)) {
			return await engine.fetch(event);
		}
	} catch (err) {
		console.error("[Omnitab SW] Fetch error, falling back to network:", err);
	}
	return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});
