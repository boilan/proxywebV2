/**
 * Minimal Wisp client used by the Omnitab test-suite.
 *
 * It performs exactly the same transport steps that libcurl-transport performs
 * in the browser:
 *
 *   1. open a WebSocket to /wisp/ and complete the wisp v2 handshake,
 *   2. CONNECT a raw TCP stream to host:port through the server,
 *   3. run TLS and HTTP/1.1 over that raw stream.
 *
 * A successful probe therefore proves the whole server side of the proxy works:
 * DNS resolution, outbound TCP, TLS and HTTP fetching all happen inside the
 * Omnitab process, not on the machine running the test.
 */
import { Duplex } from "node:stream";
import tls from "node:tls";
import { client } from "@mercuryworkshop/wisp-js/client";

const { ClientConnection } = client;

function waitForOpen(conn, timeout) {
	return new Promise((resolve, reject) => {
		if (conn.connected) return resolve();
		const timer = setTimeout(() => reject(new Error(`wisp handshake timed out after ${timeout}ms`)), timeout);
		conn.onopen = () => {
			clearTimeout(timer);
			resolve();
		};
		conn.onclose = () => {
			clearTimeout(timer);
			reject(new Error("wisp connection closed before the handshake finished"));
		};
		conn.onerror = () => {
			clearTimeout(timer);
			reject(new Error("wisp websocket error during handshake"));
		};
	});
}

function parseHttpResponse(raw) {
	const sep = raw.indexOf("\r\n\r\n");
	const headText = (sep === -1 ? raw : raw.subarray(0, sep)).toString("latin1");
	const body = sep === -1 ? Buffer.alloc(0) : raw.subarray(sep + 4);

	const lines = headText.split("\r\n");
	const statusLine = (lines.shift() || "").trim();
	const match = /^HTTP\/(\d(?:\.\d)?) (\d{3})\s?(.*)$/.exec(statusLine);

	const headers = {};
	for (const line of lines) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
	}

	return {
		statusLine,
		httpVersion: match ? match[1] : null,
		status: match ? Number(match[2]) : null,
		reason: match ? match[3] : "",
		headers,
		body,
	};
}

/**
 * Fetch a URL through the server's Wisp endpoint.
 *
 * @param {object} opts
 * @param {string} opts.wispUrl        e.g. "ws://127.0.0.1:1234/wisp/"
 * @param {string} opts.hostname
 * @param {number} opts.port
 * @param {boolean} [opts.secure]      defaults to `port === 443`
 * @param {string} [opts.path]
 * @param {number} [opts.timeout]
 * @param {number} [opts.maxBytes]     stop reading once this many bytes arrived
 * @param {Record<string,string>} [opts.extraHeaders]
 */
export async function proxiedRequest({
	wispUrl,
	hostname,
	port,
	secure,
	path = "/",
	timeout = 25000,
	maxBytes = 16384,
	extraHeaders = {},
}) {
	if (secure === undefined) secure = port === 443;

	const conn = new ClientConnection(wispUrl);
	let socket = null;
	let tunnel = null;
	let streamCloseReason = null;

	try {
		await waitForOpen(conn, timeout);

		const stream = conn.create_stream(hostname, port);
		stream.onclose = (reason) => {
			streamCloseReason = reason;
			if (tunnel && !tunnel.destroyed) tunnel.push(null);
		};

		tunnel = new Duplex({
			read() {},
			write(chunk, _enc, cb) {
				try {
					stream.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
					cb();
				} catch (err) {
					cb(err);
				}
			},
			final(cb) {
				try {
					stream.close();
				} catch (_) {}
				cb();
			},
			destroy(err, cb) {
				try {
					stream.close();
				} catch (_) {}
				cb(err);
			},
		});

		stream.onmessage = (data) => {
			if (tunnel && !tunnel.destroyed) tunnel.push(Buffer.from(data));
		};

		socket = secure
			? tls.connect({ socket: tunnel, servername: hostname, ALPNProtocols: ["http/1.1"] })
			: tunnel;

		// Always keep an error listener attached, otherwise a late socket error
		// would be an unhandled 'error' event and kill the test process.
		const socketErrors = [];
		socket.on("error", (err) => socketErrors.push(err));

		if (secure) {
			await new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`TLS handshake to ${hostname}:${port} timed out`)),
					timeout
				);
				socket.once("secureConnect", () => {
					clearTimeout(timer);
					resolve();
				});
				socket.once("error", (err) => {
					clearTimeout(timer);
					reject(err);
				});
			});
		}

		const lines = [
			`GET ${path} HTTP/1.1`,
			`Host: ${hostname}`,
			"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			"Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language: en-US,en;q=0.9",
			"Accept-Encoding: identity",
			"Connection: close",
		];
		for (const [key, value] of Object.entries(extraHeaders)) lines.push(`${key}: ${value}`);
		const request = lines.join("\r\n") + "\r\n\r\n";

		const raw = await new Promise((resolve, reject) => {
			const chunks = [];
			let total = 0;
			let settled = false;

			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(Buffer.concat(chunks, total));
			};

			const timer = setTimeout(() => {
				if (settled) return;
				if (total > 0) return finish();
				settled = true;
				reject(
					new Error(
						`no response from ${hostname}:${port} within ${timeout}ms` +
							(socketErrors.length ? ` (${socketErrors[0].message})` : "") +
							(streamCloseReason != null ? ` (stream closed with reason ${streamCloseReason})` : "")
					)
				);
			}, timeout);

			socket.on("data", (chunk) => {
				chunks.push(chunk);
				total += chunk.length;
				if (total >= maxBytes) finish();
			});
			socket.on("end", finish);
			socket.on("close", finish);

			socket.write(request);
		});

		const parsed = parseHttpResponse(raw);
		return {
			...parsed,
			bytes: raw.length,
			bodyText: parsed.body.toString("utf8"),
			streamCloseReason,
		};
	} finally {
		try {
			if (socket && typeof socket.destroy === "function") socket.destroy();
		} catch (_) {}
		try {
			if (tunnel && !tunnel.destroyed) tunnel.destroy();
		} catch (_) {}
		try {
			conn.close();
		} catch (_) {}
	}
}

/**
 * Check that the server reports a network failure for a host that cannot exist,
 * instead of hanging forever. Resolves with the received close reason.
 */
export async function probeUnreachableHost({ wispUrl, hostname, port = 443, timeout = 15000 }) {
	const conn = new ClientConnection(wispUrl);
	try {
		await waitForOpen(conn, timeout);
		const stream = conn.create_stream(hostname, port);

		return await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`server never closed the stream to ${hostname} (expected a NetworkError)`)),
				timeout
			);
			stream.onclose = (reason) => {
				clearTimeout(timer);
				resolve(reason);
			};
			stream.onmessage = () => {
				clearTimeout(timer);
				reject(new Error(`server sent data for ${hostname} even though it cannot exist`));
			};
		});
	} finally {
		try {
			conn.close();
		} catch (_) {}
	}
}
