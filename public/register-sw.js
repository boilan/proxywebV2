"use strict";
const stockSW = "/sw.js";

/**
 * List of hostnames that are allowed to run serviceworkers on http://
 */
const swAllowedHostnames = ["localhost", "127.0.0.1"];

let swRegistration = null;

/**
 * Global util
 * Used in 404.html and index.html
 *
 * The service worker must be registered *and* controlling the page before the
 * proxy engine can post its configuration, otherwise the first proxied request
 * is not intercepted and the browser shows a plain network error page.
 *
 * @returns {Promise<ServiceWorkerRegistration>}
 */
async function registerSW() {
	if (!("serviceWorker" in navigator)) {
		throw new Error("Tu navegador no soporta service workers.");
	}

	if (location.protocol !== "https:" && !swAllowedHostnames.includes(location.hostname)) {
		throw new Error("Los service workers requieren HTTPS (o localhost).");
	}

	if (!swRegistration) {
		swRegistration = await navigator.serviceWorker.register(stockSW, {
			scope: "/",
			// Never serve a stale worker: a cached sw.js keeps routing through an
			// outdated engine build after a deploy.
			updateViaCache: "none",
		});
	}

	// Ensure the active service worker has taken control of the page
	if (!navigator.serviceWorker.controller) {
		await navigator.serviceWorker.ready;

		if (!navigator.serviceWorker.controller) {
			await new Promise((resolve) => {
				const onController = () => {
					navigator.serviceWorker.removeEventListener("controllerchange", onController);
					resolve();
				};
				navigator.serviceWorker.addEventListener("controllerchange", onController);
				// A brand new registration only claims this page after `clients.claim()`
				// or a reload, so do not wait forever.
				setTimeout(resolve, 2000);
			});
		}
	}

	return swRegistration;
}
