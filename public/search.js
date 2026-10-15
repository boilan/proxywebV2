"use strict";

/**
 * Omnibox parser: turns whatever the user typed into a fully qualified URL,
 * falling back to a search query when the input is not a URL.
 *
 * Fixes vs. the original implementation:
 *  - bare domains are upgraded to https:// (sites like poki.com or youtube.com
 *    answer http:// with a redirect chain that breaks inside the proxy and leaks
 *    an extra request),
 *  - host:port and localhost/loopback addresses are recognised,
 *  - whitespace inside the input no longer produces a bogus hostname,
 *  - empty input does not produce an empty search result.
 *
 * @param {string} input
 * @param {string} template Template for a search query, e.g. "https://duckduckgo.com/?q=%s".
 * @returns {string} Fully qualified URL
 */
function search(input, template) {
	const raw = String(input == null ? "" : input).trim();

	// Absolute URL with an explicit scheme: https://example.com/test?q=1
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
		try {
			return new URL(raw).toString();
		} catch (err) {
			// malformed absolute URL, keep trying below
		}
	}

	// No spaces means it may be a bare hostname / host:port / host/path.
	if (raw && !/\s/.test(raw)) {
		// localhost, 127.0.0.1, 0.0.0.0, [::1] and host:port stay on http
		const isLoopbackOrPort =
			/^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[\S]*)?$/i.test(raw) ||
			/^[a-z0-9.-]+\.[a-z]{2,}:\d{1,5}(?:\/[\S]*)?$/i.test(raw);

		if (isLoopbackOrPort) {
			try {
				return new URL("http://" + raw).toString();
			} catch (err) {
				// fall through to the search engine
			}
		}

		// Bare domain with a plausible TLD: always prefer https
		if (/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/\S*)?$/i.test(raw)) {
			try {
				return new URL("https://" + raw).toString();
			} catch (err) {
				// fall through to the search engine
			}
		}
	}

	// Not a URL: treat the input as a search query
	const engine = template || "https://duckduckgo.com/?q=%s";
	return engine.replace("%s", encodeURIComponent(raw));
}
