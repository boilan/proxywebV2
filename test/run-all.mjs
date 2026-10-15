/**
 * Omnitab test suite.
 *
 *   1. boots the real server (src/index.js) on a free port,
 *   2. checks the portal shell, all runtime assets, headers and caching,
 *   3. checks the /libcurl patch (the `wasm_ready` regression) is actually served,
 *   4. drives the Wisp endpoint with a real client and fetches live sites
 *      (DNS + TCP + TLS + HTTP all happen inside the server process).
 *
 * Usage: npm test        (or: node test/run-all.mjs)
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { proxiedRequest, probeUnreachableHost } from "./wisp-probe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const results = [];
let failures = 0;

function record(name, ok, detail = "") {
	results.push({ name, ok, detail });
	if (!ok) failures++;
	const mark = ok ? "\u2713" : "\u2717";
	console.log(`${mark} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function check(name, fn) {
	try {
		const detail = await fn();
		record(name, true, detail == null ? "" : String(detail));
	} catch (err) {
		record(name, false, err && err.message ? err.message : String(err));
	}
}

function findFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function waitForServer(baseUrl, proc, timeout = 30000) {
	const deadline = Date.now() + timeout;
	let lastError = "no attempt";
	while (Date.now() < deadline) {
		if (proc.exitCode != null) {
			throw new Error(`server exited early with code ${proc.exitCode}`);
		}
		try {
			const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return await res.json();
			lastError = `healthz returned ${res.status}`;
		} catch (err) {
			lastError = err.message;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function main() {
	const port = await findFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const wispUrl = `ws://127.0.0.1:${port}/wisp/`;

	console.log(`\nOmnitab test-suite\nserver: ${baseUrl}\n`);

	// The probe deliberately aborts each socket after `maxBytes`, so packets for
	// the already-closed stream keep arriving. Collect those client warnings and
	// report them once instead of interleaving them with the check results.
	const latePackets = [];
	const realWarn = console.warn;
	console.warn = (...args) => {
		const line = args.map(String).join(" ");
		if (line.includes("wisp client warning")) {
			latePackets.push(line);
			return;
		}
		realWarn(...args);
	};

	const proc = spawn(process.execPath, ["--max-old-space-size=384", "src/index.js"], {
		cwd: root,
		env: { ...process.env, PORT: String(port), NODE_ENV: "test" },
		stdio: ["ignore", "pipe", "pipe"],
	});

	let serverLog = "";
	proc.stdout.on("data", (d) => (serverLog += d.toString()));
	proc.stderr.on("data", (d) => (serverLog += d.toString()));

	try {
		const health = await waitForServer(baseUrl, proc);
		record(
			"server boots and /healthz answers",
			health.status === "ok" && health.service === "omnitab",
			JSON.stringify(health)
		);

		console.log("\n-- portal shell and assets --");

		await check("GET / returns the Omnitab portal", async () => {
			const res = await fetch(`${baseUrl}/`);
			const html = await res.text();
			if (res.status !== 200) throw new Error(`status ${res.status}`);
			if (!res.headers.get("content-type")?.includes("text/html")) {
				throw new Error(`content-type ${res.headers.get("content-type")}`);
			}
			if (!html.includes("Omnitab")) throw new Error("branding missing");
			if (!html.includes("/search.js") || !html.includes("/index.js")) {
				throw new Error("portal scripts are not referenced");
			}
			return "200 text/html";
		});

		await check("portal is cross-origin isolated (COOP + COEP)", async () => {
			const res = await fetch(`${baseUrl}/`);
			const coop = res.headers.get("cross-origin-opener-policy");
			const coep = res.headers.get("cross-origin-embedder-policy");
			if (coop !== "same-origin" || coep !== "require-corp") {
				throw new Error(`coop=${coop} coep=${coep}`);
			}
			return `coop=${coop} coep=${coep}`;
		});

		await check("HTML shell is revalidated (no stale portal after a deploy)", async () => {
			const res = await fetch(`${baseUrl}/`);
			const cc = res.headers.get("cache-control");
			if (!cc || !cc.includes("no-cache")) throw new Error(`cache-control=${cc}`);
			return cc;
		});

		await check("portal JS/CSS is revalidated", async () => {
			for (const url of ["/index.js", "/search.js", "/register-sw.js", "/index.css"]) {
				const cc = (await fetch(`${baseUrl}${url}`)).headers.get("cache-control") || "";
				if (!cc.includes("no-cache")) throw new Error(`${url}: cache-control=${cc}`);
			}
			return "no-cache";
		});

		await check("vendor runtimes stay immutable", async () => {
			for (const url of ["/scram/scramjet.all.js", "/baremux/worker.js", "/libcurl/index.mjs"]) {
				const cc = (await fetch(`${baseUrl}${url}`)).headers.get("cache-control") || "";
				if (!cc.includes("immutable")) throw new Error(`${url}: cache-control=${cc}`);
			}
			return "immutable";
		});

		await check("sw.js served without caching", async () => {
			const res = await fetch(`${baseUrl}/sw.js`);
			const cc = res.headers.get("cache-control") || "";
			if (res.status !== 200) throw new Error(`status ${res.status}`);
			if (!/no-store/.test(cc)) throw new Error(`cache-control=${cc}`);
			if (!(await res.text()).includes("ScramjetServiceWorker")) {
				throw new Error("sw.js is not the Scramjet service worker");
			}
			return cc;
		});

		const assets = [
			["/index.css", "text/css"],
			["/index.js", "javascript"],
			["/search.js", "javascript"],
			["/register-sw.js", "javascript"],
			["/scram/scramjet.all.js", "javascript"],
			["/scram/scramjet.wasm.wasm", "wasm"],
			["/baremux/worker.js", "javascript"],
			["/libcurl/index.mjs", "javascript"],
		];
		for (const [url, type] of assets) {
			await check(`GET ${url}`, async () => {
				const res = await fetch(`${baseUrl}${url}`);
				const ct = res.headers.get("content-type") || "";
				if (res.status !== 200) throw new Error(`status ${res.status}`);
				if (!ct.includes(type)) throw new Error(`content-type ${ct} (expected ${type})`);
				return `200 ${ct.split(";")[0]}`;
			});
		}

		await check("portal exposes the YouTube / TikTok / Poki shortcuts", async () => {
			const html = await (await fetch(`${baseUrl}/`)).text();
			for (const url of [
				"https://www.youtube.com",
				"https://www.tiktok.com",
				"https://poki.com",
				"https://poki.com/en/g/subway-surfers",
				"https://poki.com/en/g/temple-run-2",
			]) {
				if (!html.includes(`data-url="${url}"`)) throw new Error(`missing shortcut ${url}`);
			}
			return "5 shortcuts linked";
		});

		await check("portal shows no upstream branding (logo and name removed)", async () => {
			const html = await (await fetch(`${baseUrl}/`)).text();
			if (html.includes("sj.png")) throw new Error("the old logo image is still referenced");
			// vendor script/asset paths are the only place where the upstream name may
			// still appear (they are library file names that cannot be renamed)
			const stripped = html.replace(/(?:src|href)="\/scram\/[^"]*"/g, "");
			const hit = /scramjet/i.exec(stripped);
			if (hit) {
				throw new Error(`portal still mentions it near: …${stripped.slice(Math.max(0, hit.index - 40), hit.index + 40)}…`);
			}
			return "clean";
		});

		await check("old logo asset is gone and the new one is served", async () => {
			const old = await fetch(`${baseUrl}/sj.png`);
			if (old.status !== 404) throw new Error(`/sj.png returned ${old.status}, expected 404`);
			const svg = await fetch(`${baseUrl}/favicon.svg`);
			const ct = svg.headers.get("content-type") || "";
			if (svg.status !== 200 || !ct.includes("svg")) throw new Error(`/favicon.svg -> ${svg.status} ${ct}`);
			const ico = await fetch(`${baseUrl}/favicon.ico`);
			if (ico.status !== 200) throw new Error(`/favicon.ico -> ${ico.status}`);
			return "sj.png 404, favicon.svg + favicon.ico 200";
		});

		await check("client and server agree on the proxied URL prefix", async () => {
			const client = readFileSync(path.join(root, "public/index.js"), "utf8");
			const clientPrefix = /prefix:\s*"([^"]+)"/.exec(client);
			if (!clientPrefix) throw new Error("public/index.js does not configure a prefix");
			const server = readFileSync(path.join(root, "src/index.js"), "utf8");
			const serverPrefix = /const PROXY_PREFIX = "([^"]+)"/.exec(server);
			if (!serverPrefix) throw new Error("src/index.js does not define PROXY_PREFIX");
			if (clientPrefix[1] !== serverPrefix[1]) {
				throw new Error(`client prefix ${clientPrefix[1]} != server prefix ${serverPrefix[1]}`);
			}
			if (clientPrefix[1] !== "/go/") throw new Error(`unexpected prefix ${clientPrefix[1]}`);
			return `${clientPrefix[1]} (client + server)`;
		});

		await check("un-intercepted proxy URL falls back to the error page", async () => {
			const res = await fetch(`${baseUrl}/go/https%3A%2F%2Fexample.com%2F`);
			const html = await res.text();
			if (res.status !== 404) throw new Error(`status ${res.status}`);
			const cc = res.headers.get("cache-control") || "";
			if (!cc.includes("no-store")) throw new Error(`cache-control=${cc}`);
			if (!html.includes("Omnitab")) throw new Error("error page branding missing");
			return "404 error page, no-store";
		});

		await check("unknown path returns the error page", async () => {
			const res = await fetch(`${baseUrl}/definitely-not-here`);
			const html = await res.text();
			if (res.status !== 404) throw new Error(`status ${res.status}`);
			if (!html.includes("Omnitab")) throw new Error("error page branding missing");
			return "404 text/html";
		});

		console.log("\n-- libcurl transport patch (wasm_ready regression) --");

		await check("served /libcurl/index.mjs is the patched copy", async () => {
			const local = readFileSync(path.join(root, "public/libcurl/index.mjs"));
			const served = Buffer.from(await (await fetch(`${baseUrl}/libcurl/index.mjs`)).arrayBuffer());
			const hash = (buf) => createHash("sha256").update(buf).digest("hex");
			if (hash(local) !== hash(served)) throw new Error("served copy differs from public/libcurl/index.mjs");
			return `sha256 ${hash(served).slice(0, 12)}…`;
		});

		await check("LibcurlClient.init() no longer reads the out-of-scope wasm_ready", async () => {
			const text = await (await fetch(`${baseUrl}/libcurl/index.mjs`)).text();
			if (/if \(!wasm_ready\) \{\s*await load_wasm\(\)/.test(text)) {
				throw new Error("the buggy `if (!wasm_ready) { await load_wasm(); }` guard is still present");
			}
			if (!/libcurl\.set_websocket\(this\.wisp\);\s*await load_wasm\(\);/.test(text)) {
				throw new Error("expected `set_websocket(...); await load_wasm();` in LibcurlClient.init()");
			}
			return "patched";
		});

		await check("installed libcurl transport contains the same patch", async () => {
			const installed = readFileSync(
				path.join(root, "node_modules/@mercuryworkshop/libcurl-transport/dist/index.mjs")
			);
			const served = Buffer.from(await (await fetch(`${baseUrl}/libcurl/index.mjs`)).arrayBuffer());
			if (!installed.equals(served)) throw new Error("node_modules copy is out of sync (postinstall did not run)");
			return "in sync";
		});

		console.log("\n-- omnibox parser (unit) --");

		await check("search() resolves URLs, https-upgrades domains and falls back to the engine", async () => {
			const context = vm.createContext({ URL, encodeURIComponent });
			vm.runInContext(readFileSync(path.join(root, "public/search.js"), "utf8"), context);
			const search = context.search;
			if (typeof search !== "function") throw new Error("public/search.js did not define search()");

			const engine = "https://duckduckgo.com/?q=%s";
			const cases = [
				// bare domains are upgraded to https (they used to become http://)
				["youtube.com", "https://youtube.com/"],
				["poki.com", "https://poki.com/"],
				["www.tiktok.com", "https://www.tiktok.com/"],
				["poki.com/en/g/subway-surfers", "https://poki.com/en/g/subway-surfers"],
				["sub.example.co.uk/path?q=1#h", "https://sub.example.co.uk/path?q=1#h"],
				// explicit schemes are preserved
				["https://example.com/x?y=1", "https://example.com/x?y=1"],
				["http://example.com/", "http://example.com/"],
				// hosts with a port stay on http
				["example.com:8080", "http://example.com:8080/"],
				["localhost:3000", "http://localhost:3000/"],
				["127.0.0.1:8080/status", "http://127.0.0.1:8080/status"],
				// free text is a search query
				["hola mundo", "https://duckduckgo.com/?q=hola%20mundo"],
				["x", "https://duckduckgo.com/?q=x"],
				["not a .url with spaces.com", "https://duckduckgo.com/?q=not%20a%20.url%20with%20spaces.com"],
			];

			for (const [input, expected] of cases) {
				const actual = search(input, engine);
				if (actual !== expected) throw new Error(`search(${JSON.stringify(input)}) = ${actual}, expected ${expected}`);
			}
			return `${cases.length} cases`;
		});

		console.log("\n-- wisp proxy: real outbound fetches --");

		const liveSites = [
			{
				label: "https://example.com/ (asserts full body)",
				hostname: "example.com",
				port: 443,
				path: "/",
				assert(res) {
					if (res.status !== 200) throw new Error(`status ${res.status}`);
					if (!/example domain/i.test(res.bodyText)) throw new Error("body does not look like example.com");
				},
				success(res) {
					return `${res.statusLine} · ${res.bytes} bytes`;
				},
			},
			{
				label: "http://example.com/ (plain TCP tunnel, port 80)",
				hostname: "example.com",
				port: 80,
				secure: false,
				path: "/",
				assert(res) {
					if (res.status !== 200) throw new Error(`status ${res.status}`);
				},
				success(res) {
					return `${res.statusLine} · ${res.bytes} bytes`;
				},
			},
			{
				label: "https://www.youtube.com/",
				hostname: "www.youtube.com",
				port: 443,
				path: "/",
				// 403/429 are what a datacenter IP gets from YouTube; either way a
				// complete HTTP response travelled through the tunnel, which is what
				// this probe is asserting.
				accept: [200, 301, 302, 303, 307, 308, 403, 429],
				success(res) {
					return `${res.statusLine} · ${res.bytes} bytes`;
				},
			},
			{
				label: "https://poki.com/",
				hostname: "poki.com",
				port: 443,
				path: "/",
				accept: [200, 301, 302, 303, 307, 308, 403, 429],
				success(res) {
					return `${res.statusLine} · ${res.bytes} bytes`;
				},
			},
			{
				label: "https://www.tiktok.com/",
				hostname: "www.tiktok.com",
				port: 443,
				path: "/",
				accept: [200, 301, 302, 303, 307, 308, 403, 429],
				success(res) {
					return `${res.statusLine} · ${res.bytes} bytes`;
				},
			},
			{
				label: "https://duckduckgo.com/?q=hola (URL from the original bug report)",
				hostname: "duckduckgo.com",
				port: 443,
				path: "/?q=hola",
				accept: [200, 301, 302, 303, 307, 308, 403, 429],
				success(res) {
					return `${res.statusLine} · ${res.bytes} bytes`;
				},
			},
		];

		for (const site of liveSites) {
			await check(`wisp fetch ${site.label}`, async () => {
				const res = await proxiedRequest({
					wispUrl,
					hostname: site.hostname,
					port: site.port,
					secure: site.secure,
					path: site.path,
				});
				if (res.status == null) throw new Error(`malformed HTTP response: ${res.statusLine || "<empty>"}`);
				if (site.assert) site.assert(res);
				if (site.accept && !site.accept.includes(res.status)) {
					throw new Error(`unexpected status ${res.status}`);
				}
				if (!res.headers["content-type"]) throw new Error("response has no content-type header");
				return site.success ? site.success(res) : res.statusLine;
			});
		}

		await check("unreachable host is closed with a NetworkError", async () => {
			const reason = await probeUnreachableHost({
				wispUrl,
				hostname: "this-host-cannot-exist-omnitab.invalid",
				port: 443,
			});
			if (reason !== 3) throw new Error(`expected close reason 3 (NetworkError), got ${reason}`);
			return "close reason 3";
		});
	} catch (err) {
		record("test-suite ran to completion", false, err && err.message ? err.message : String(err));
	} finally {
		console.warn = realWarn;
		if (latePackets.length) {
			console.log(
				`\nnote: ${latePackets.length} packet(s) arrived after the probe closed its stream (expected, sockets are aborted after maxBytes)`
			);
		}
		proc.kill("SIGTERM");
		await new Promise((resolve) => {
			if (proc.exitCode != null) return resolve();
			proc.once("exit", resolve);
			setTimeout(() => {
				proc.kill("SIGKILL");
				resolve();
			}, 5000).unref();
		});
	}

	const passed = results.length - failures;
	console.log(`\n${passed}/${results.length} checks passed`);
	if (failures > 0) {
		console.log("\nserver log:\n" + serverLog.trim());
	}
	process.exitCode = failures === 0 ? 0 : 1;
}

main();
