import { fileURLToPath } from "url";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCompress from "@fastify/compress";

import { scramjetPath as engineRuntimePath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { existsSync } from "node:fs";
import path from "node:path";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const SERVICE_NAME = "omnitab";
// URL prefix used for every proxied navigation. Must stay in sync with the
// `prefix` passed to the engine controller in public/index.js.
const PROXY_PREFIX = "/go/";
const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// Wisp Configuration: DNS and stream policies
logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [],
	dns_servers: ["1.1.1.1", "8.8.8.8", "1.0.0.1", "8.8.4.4"],
});

// Fastify instance optimized for Render Free (512MB RAM, 0.1 CPU)
const fastify = Fastify({
	logger: false,
	trustProxy: true,
	connectionTimeout: 30000,
	keepAliveTimeout: 5000,
	maxRequestsPerSocket: 1000,
});

// HTTP compression: reduces payload by up to 80% with low CPU level
await fastify.register(fastifyCompress, {
	threshold: 1024,
	encodings: ["gzip", "deflate"],
	zlibOptions: {
		level: 5,
	},
});

// Cross-Origin isolation headers so the proxied client can use SharedArrayBuffer.
//
// `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
// make the portal `crossOriginIsolated`. When that is true the proxy engine also
// publishes COOP/COEP/CORP on every proxied response, which is what lets proxied
// pages use synchronous XHR and APIs such as SharedArrayBuffer and WASM threads.
const isolationEnabled = process.env.OMNITAB_ISOLATION !== "off";

fastify.addHook("onRequest", async (_req, reply) => {
	if (isolationEnabled) {
		reply.header("Cross-Origin-Opener-Policy", "same-origin");
		reply.header("Cross-Origin-Embedder-Policy", "require-corp");
	} else {
		// Fallback used when third party assets (fonts, avatars...) cannot be proxied
		reply.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
	}
	reply.header("Cross-Origin-Resource-Policy", "cross-origin");
	reply.header("Access-Control-Allow-Origin", "*");
	reply.header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS");
	reply.header("Access-Control-Allow-Headers", "*");
	reply.header("Referrer-Policy", "no-referrer");
	reply.header("X-Content-Type-Options", "nosniff");
});

// Immutable caching options for static vendor runtime packages
const vendorStaticOptions = {
	maxAge: "1d",
	immutable: true,
	etag: true,
	lastModified: true,
	cacheControl: true,
};

// Liveness probe: keeps Render from restarting a healthy instance and lets the
// test suite assert the process really finished booting.
fastify.get("/healthz", async (_req, reply) => {
	reply.header("Cache-Control", "no-store");
	return {
		status: "ok",
		service: SERVICE_NAME,
		uptime: Math.round(process.uptime()),
	};
});

// Cache policy.
//
// @fastify/static writes its own Cache-Control while streaming, so the policy is
// applied in an onSend hook instead of the plugin's setHeaders callback (whose
// header was silently overwritten by the plugin).
//
// The portal's own files are always revalidated: after a deploy a browser holding
// an hour-old index.js/search.js keeps running the old client code and the fix
// looks like it did not work. Vendor runtimes below keep their immutable cache.
fastify.addHook("onSend", async (request, reply) => {
	const url = (request.raw.url || "/").split("?")[0];

	// Vendor runtime bundles and the wasm binary never change for a given build
	if (url.startsWith("/scram/") || url.startsWith("/libcurl/") || url.startsWith("/baremux/")) {
		return;
	}
	// /healthz sets its own no-store
	if (url === "/healthz") {
		return;
	}
	// Error pages: a proxy-prefixed URL that reached the server means the service
	// worker is not controlling the page yet, so it must never be cached there.
	if (reply.statusCode === 404) {
		reply.header("Cache-Control", url.startsWith(PROXY_PREFIX) ? "no-store" : "no-cache");
		return;
	}

	if (url === "/sw.js" || url === "/register-sw.js") {
		reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
	} else {
		reply.header("Cache-Control", "no-cache");
	}
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
	etag: true,
	lastModified: true,
});

fastify.register(fastifyStatic, {
	root: engineRuntimePath,
	prefix: "/scram/",
	decorateReply: false,
	...vendorStaticOptions,
});

fastify.register(fastifyStatic, {
	root: existsSync(path.join(publicPath, "libcurl")) ? path.join(publicPath, "libcurl") : libcurlPath,
	prefix: "/libcurl/",
	decorateReply: false,
	...vendorStaticOptions,
});

fastify.register(fastifyStatic, {
	root: baremuxPath,
	prefix: "/baremux/",
	decorateReply: false,
	...vendorStaticOptions,
});

// Rendered proxy URLs (PROXY_PREFIX) are not routable on the server: they are
// intercepted by the service worker. If one reaches us the client is not
// controlling the page yet, so answer with the error page (its Cache-Control is
// decided in the onSend hook, which is the only place `sendFile` does not
// overwrite).
fastify.setNotFoundHandler((_req, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

// Direct HTTP upgrade handler for Wisp WebSocket connections with leak safeguards
fastify.server.on("upgrade", (req, socket, head) => {
	socket.on("error", () => {
		socket.destroy();
	});

	if (req.url && (req.url.endsWith("/wisp/") || req.url.includes("/wisp/") || req.url === "/wisp")) {
		socket.setKeepAlive(true, 10000);
		socket.setNoDelay(true);
		wisp.routeRequest(req, socket, head);
	} else {
		socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
		socket.destroy();
	}
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();
	console.log(`[${SERVICE_NAME}] listening on http://0.0.0.0:${address.port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
	console.log("SIGTERM/SIGINT received: closing HTTP and Wisp connections gracefully");
	fastify.close(() => {
		process.exit(0);
	});
	// Force shutdown if connections do not close within 5 seconds
	setTimeout(() => {
		process.exit(0);
	}, 5000).unref();
}

let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8080;

fastify.listen({
	port: port,
	host: "0.0.0.0",
});
