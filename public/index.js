"use strict";

/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("sj-form");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("sj-address");
/**
 * @type {HTMLInputElement}
 */
const searchEngine = document.getElementById("sj-search-engine");
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("sj-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("sj-error-code");

// Proxy engine + transport singletons
let proxyEngine = null;
let connection = null;
let isTransportReady = false;
let proxyReadyPromise = null;
let proxyEngineInitPromise = null;

function initProxyEngine() {
	if (!proxyEngine) {
		try {
			if (typeof $scramjetLoadController === "function") {
				const { ScramjetController } = $scramjetLoadController();
				proxyEngine = new ScramjetController({
						prefix: "/go/",
						files: {
							wasm: "/scram/scramjet.wasm.wasm",
							all: "/scram/scramjet.all.js",
							sync: "/scram/scramjet.sync.js",
						},
					flags: {
						serviceworkers: true,
						syncxhr: false,
						strictRewrites: false,
						rewriterLogs: false,
						captureErrors: false,
						cleanErrors: false,
						scramitize: true,
						sourcemaps: false,
						destructureRewrites: false,
						interceptDownloads: false,
						allowInvalidJs: true,
						allowFailedIntercepts: true,
					},
				});
			}
		} catch (e) {
			console.warn("proxy engine initialization pending:", e);
		}
	}

	if (!connection) {
		try {
			if (typeof BareMux !== "undefined" && BareMux.BareMuxConnection) {
				connection = new BareMux.BareMuxConnection("/baremux/worker.js");
			}
		} catch (e) {
			console.warn("BareMux connection pending:", e);
		}
	}
}

// Create the controller up front (cheap, allocates nothing heavy), but never
// call init() here: init() posts the config to the service worker controller,
// and at page load there is no controller yet.
initProxyEngine();

/**
 * Runs `proxyEngine.init()` exactly once. Previously init() ran both at page load
 * and inside ensureProxyReady(), which registered the message listener twice and
 * posted the loadConfig message while the page was still uncontrolled.
 */
function initProxyEngineOnce() {
	if (proxyEngineInitPromise) return proxyEngineInitPromise;
	proxyEngineInitPromise = (async () => {
		initProxyEngine();
		if (proxyEngine && typeof proxyEngine.init === "function") {
			try {
				await proxyEngine.init();
			} catch (initErr) {
				console.warn("proxy engine init note:", initErr);
			}
		}
	})();
	return proxyEngineInitPromise;
}

/**
 * Ensures ServiceWorker and Wisp transport are configured
 */
async function ensureProxyReady() {
	if (proxyReadyPromise) return proxyReadyPromise;
	proxyReadyPromise = (async () => {
		initProxyEngine();

		if (typeof registerSW === "function") {
			await registerSW();
		}

		// The service worker is now (or will be) controlling this page, so the
		// config it needs can be handed over.
		await initProxyEngineOnce();

		const wispUrl =
			(location.protocol === "https:" ? "wss" : "ws") +
			"://" +
			location.host +
			"/wisp/";

		if (connection && !isTransportReady) {
			try {
				const currentTransport = await connection.getTransport();
				if (currentTransport !== "/libcurl/index.mjs") {
					await connection.setTransport("/libcurl/index.mjs", [
						{ websocket: wispUrl },
					]);
				}
				isTransportReady = true;
			} catch (transportErr) {
				console.warn("Transport setting notice:", transportErr);
			}
		}
	})();
	return proxyReadyPromise;
}

/**
 * Opens a destination in an about:blank tab with full proxy navigation bar & controls
 * @param {string} rawInput URL or search query
 */
async function navigateInAboutBlank(rawInput) {
	if (!rawInput || !rawInput.trim()) return;

	// Clear previous error messages
	if (error) error.textContent = "";
	if (errorCode) errorCode.textContent = "";

	const engineTemplate = searchEngine ? searchEngine.value : "https://www.google.com/search?q=%s";
	const resolvedUrl = typeof search === "function" ? search(rawInput.trim(), engineTemplate) : rawInput.trim();

	// Step 1: Open about:blank tab synchronously within user-gesture stack to evade popup blockers
	const newTab = window.open("about:blank", "_blank");

	if (!newTab || newTab.closed || typeof newTab.closed === "undefined") {
		if (error) {
			error.innerHTML = "<strong>Aviso de ventana emergente:</strong> Tu navegador ha bloqueado la nueva pestaña. Por favor, autoriza las ventanas emergentes (popups) para este sitio y pulsa «Ir» nuevamente.";
		}
		return;
	}

	// Prepare loading state inside about:blank
	try {
		newTab.document.title = "Iniciando Omnitab...";
		newTab.document.body.style.backgroundColor = "#07090e";
		newTab.document.body.style.color = "#f8fafc";
		newTab.document.body.style.fontFamily = "system-ui, -apple-system, sans-serif";
		newTab.document.body.style.margin = "0";
		newTab.document.body.style.overflow = "hidden";
	} catch (e) {
		console.warn("Could not set initial tab styles:", e);
	}

	try {
		// Step 2: Ensure Service Worker and transport are active
		await ensureProxyReady();

		if (!proxyEngine) {
			initProxyEngine();
		}

			if (!proxyEngine) {
			throw new Error("El motor de interceptación no se ha podido inicializar. Comprueba que el backend esté ejecutándose y que el sitio se sirva por HTTPS.");
		}

		// Step 3: Write HTML shell into about:blank document
		newTab.document.open();
		newTab.document.write(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <base href="${location.origin}/" />
  <title>${escapeHtml(rawInput)} - Omnitab</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Plus Jakarta Sans", sans-serif;
      background: #07090e;
      color: #f8fafc;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .scram-top-bar {
      height: 52px;
      background: rgba(15, 20, 32, 0.95);
      border-bottom: 1px solid rgba(139, 92, 246, 0.25);
      display: flex;
      align-items: center;
      padding: 0 1rem;
      gap: 0.75rem;
      backdrop-filter: blur(12px);
      z-index: 100;
      flex-shrink: 0;
    }
    .nav-btn-group {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .nav-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #e2e8f0;
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.18s ease;
    }
    .nav-btn:hover:not(:disabled) {
      background: rgba(139, 92, 246, 0.25);
      border-color: rgba(139, 92, 246, 0.5);
      color: #ffffff;
    }
    .nav-btn:disabled, .nav-btn.disabled {
      opacity: 0.32;
      cursor: not-allowed;
      pointer-events: none;
    }
    .nav-url-form {
      flex: 1;
      display: flex;
      align-items: center;
      background: rgba(7, 9, 14, 0.85);
      border: 1px solid rgba(139, 92, 246, 0.3);
      border-radius: 10px;
      padding: 0.25rem 0.5rem 0.25rem 0.85rem;
      gap: 0.5rem;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .nav-url-form:focus-within {
      border-color: #a855f7;
      box-shadow: 0 0 0 2px rgba(168, 85, 247, 0.25);
    }
    .nav-lock-icon {
      color: #38bdf8;
      display: flex;
      align-items: center;
    }
    .nav-url-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #f8fafc;
      font-size: 0.9rem;
      font-family: inherit;
      min-width: 0;
    }
    .nav-btn-go {
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      border: none;
      color: white;
      font-weight: 600;
      font-size: 0.82rem;
      padding: 0.35rem 0.85rem;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .nav-btn-go:hover {
      background: linear-gradient(135deg, #4338ca, #6d28d9);
    }
    .nav-status {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      font-size: 0.75rem;
      color: #94a3b8;
      font-weight: 500;
      padding-left: 0.5rem;
      border-left: 1px solid rgba(255, 255, 255, 0.1);
      flex-shrink: 0;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #34d399;
      box-shadow: 0 0 6px #34d399;
    }
    .scram-frame-wrapper {
      flex: 1;
      width: 100%;
      height: calc(100vh - 52px);
      position: relative;
      background: #07090e;
    }
    .scram-frame-wrapper iframe {
      width: 100%;
      height: 100%;
      border: none;
      background: #07090e;
      display: block;
    }
    .nav-loader {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 2.5px;
      background: linear-gradient(90deg, #38bdf8, #8b5cf6, #38bdf8);
      background-size: 200% 100%;
      animation: loadingBar 1.6s infinite linear;
      display: none;
      z-index: 10;
    }
    .nav-loader.active {
      display: block;
    }
    @keyframes loadingBar {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
  </style>
</head>
<body>
  <div class="scram-top-bar">
    <div class="nav-btn-group">
      <button id="nav-back" class="nav-btn disabled" disabled title="Atrás (Página anterior)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"></line>
          <polyline points="12 19 5 12 12 5"></polyline>
        </svg>
      </button>
      <button id="nav-forward" class="nav-btn disabled" disabled title="Adelante (Página siguiente)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="5" y1="12" x2="19" y2="12"></line>
          <polyline points="12 5 19 12 12 19"></polyline>
        </svg>
      </button>
      <button id="nav-reload" class="nav-btn" title="Recargar página">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
      </button>
    </div>

    <form id="nav-url-form" class="nav-url-form">
      <span class="nav-lock-icon" title="Proxy Interceptor Activo">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </span>
      <input id="nav-url-input" class="nav-url-input" type="text" placeholder="Escribe una URL o busca libremente..." spellcheck="false" autocomplete="off" />
      <button type="submit" class="nav-btn-go">Ir</button>
    </form>

    <div class="nav-status">
      <span class="status-dot"></span>
      <span>Omnitab &bull; Wisp</span>
    </div>
  </div>

  <div class="scram-frame-wrapper">
    <div id="nav-loader" class="nav-loader active"></div>
  </div>
</body>
</html>`);
		newTab.document.close();

		// Step 4: Create the proxied frame and mount it into about:blank document
		const frameContainer = newTab.document.querySelector(".scram-frame-wrapper");
		const frameEl = newTab.document.createElement("iframe");
		frameEl.id = "sj-frame";
		frameEl.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write; autoplay; picture-in-picture");
		frameContainer.appendChild(frameEl);

		const proxiedFrame = proxyEngine.createFrame(frameEl);

		// Step 5: Setup navigation bar controls and history tracking
		const backBtn = newTab.document.getElementById("nav-back");
		const forwardBtn = newTab.document.getElementById("nav-forward");
		const reloadBtn = newTab.document.getElementById("nav-reload");
		const navUrlInput = newTab.document.getElementById("nav-url-input");
		const navUrlForm = newTab.document.getElementById("nav-url-form");
		const navLoader = newTab.document.getElementById("nav-loader");

		if (navUrlInput) {
			navUrlInput.value = rawInput.trim();
		}

		let historyStack = [resolvedUrl];
		let historyIndex = 0;
		let isHistoryNavigation = false;

		function updateButtons() {
			if (backBtn) {
				const canBack = historyIndex > 0;
				backBtn.disabled = !canBack;
				backBtn.classList.toggle("disabled", !canBack);
			}
			if (forwardBtn) {
				const canForward = historyIndex < historyStack.length - 1;
				forwardBtn.disabled = !canForward;
				forwardBtn.classList.toggle("disabled", !canForward);
			}
		}

		if (backBtn) {
			backBtn.addEventListener("click", () => {
				if (historyIndex > 0) {
					isHistoryNavigation = true;
					historyIndex--;
					updateButtons();
					if (navLoader) navLoader.classList.add("active");
					proxiedFrame.back();
				}
			});
		}

		if (forwardBtn) {
			forwardBtn.addEventListener("click", () => {
				if (historyIndex < historyStack.length - 1) {
					isHistoryNavigation = true;
					historyIndex++;
					updateButtons();
					if (navLoader) navLoader.classList.add("active");
					proxiedFrame.forward();
				}
			});
		}

		if (reloadBtn) {
			reloadBtn.addEventListener("click", () => {
				if (navLoader) navLoader.classList.add("active");
				proxiedFrame.reload();
			});
		}

		if (navUrlForm) {
			navUrlForm.addEventListener("submit", (e) => {
				e.preventDefault();
				const newQuery = navUrlInput.value.trim();
				if (!newQuery) return;

				const nextUrl = typeof search === "function" ? search(newQuery, engineTemplate) : newQuery;
				if (navLoader) navLoader.classList.add("active");

				// Truncate any forward entries on fresh search
				if (historyIndex < historyStack.length - 1) {
					historyStack = historyStack.slice(0, historyIndex + 1);
				}
				historyStack.push(nextUrl);
				historyIndex = historyStack.length - 1;
				updateButtons();

				newTab.document.title = newQuery + " - Omnitab";
				proxiedFrame.go(nextUrl);
			});
		}

		// Frame load event: update URL bar, title, and push history for in-page link clicks
		frameEl.addEventListener("load", () => {
			if (navLoader) navLoader.classList.remove("active");

			try {
				const win = frameEl.contentWindow;
				if (win && win.location && win.location.href && win.location.href !== "about:blank") {
					const fullHref = win.location.href;
					let decoded = null;
					try {
						decoded = proxyEngine.decodeUrl(fullHref);
					} catch (decErr) {}

					const currentDisplayUrl = decoded || fullHref;
					// NOTE: `document` here is the portal document (the opener), not the
					// popup; the focus check must look at the popup's own document.
					if (navUrlInput && newTab.document.activeElement !== navUrlInput) {
						navUrlInput.value = currentDisplayUrl;
					}

					if (win.document && win.document.title) {
						newTab.document.title = win.document.title + " - Omnitab";
					}

					if (!isHistoryNavigation) {
						if (historyStack[historyIndex] !== currentDisplayUrl) {
							if (historyIndex < historyStack.length - 1) {
								historyStack = historyStack.slice(0, historyIndex + 1);
							}
							historyStack.push(currentDisplayUrl);
							historyIndex = historyStack.length - 1;
						}
					}
				}
			} catch (accessErr) {
				console.warn("Frame origin inspection notice:", accessErr);
			} finally {
				isHistoryNavigation = false;
				updateButtons();
			}
		});

		// Step 6: Start proxy navigation in the proxied frame
		proxiedFrame.go(resolvedUrl);

	} catch (navErr) {
		console.error("Navigation error:", navErr);
		if (error) {
			error.textContent = "Error al iniciar la sesión de navegación en la nueva pestaña.";
		}
		if (errorCode) {
			errorCode.textContent = navErr.toString();
		}
		try {
			newTab.document.title = "Error - Omnitab";
			const loader = newTab.document.getElementById("nav-loader");
			if (loader) loader.classList.remove("active");
		} catch (e) {}
	}
}

function escapeHtml(str) {
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

// Form submission handler: opens in about:blank tab
if (form) {
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const query = address ? address.value.trim() : "";
		if (!query) return;

		navigateInAboutBlank(query);
	});
}

// Quick Access & Game Cards: Populate and open in about:blank tab
document.querySelectorAll("[data-url]").forEach((el) => {
	el.addEventListener("click", (e) => {
		e.preventDefault();
		const targetUrl = el.getAttribute("data-url");
		if (targetUrl) {
			if (address) address.value = targetUrl;
			navigateInAboutBlank(targetUrl);
		}
	});
});

// Search Engine Selector
const engineButtons = document.querySelectorAll(".engine-btn");
engineButtons.forEach((btn) => {
	btn.addEventListener("click", () => {
		engineButtons.forEach((b) => b.classList.remove("active"));
		btn.classList.add("active");
		const selectedEngine = btn.getAttribute("data-engine");
		if (selectedEngine && searchEngine) {
			searchEngine.value = selectedEngine;
		}
	});
});

// Recommended Games Collapsible Toggle
const toggleGamesBtn = document.getElementById("toggle-games-btn");
const gamesSection = document.getElementById("games-section");
if (toggleGamesBtn && gamesSection) {
	toggleGamesBtn.addEventListener("click", () => {
		const isHidden = gamesSection.classList.toggle("hidden");
		toggleGamesBtn.setAttribute("aria-expanded", String(!isHidden));
		const toggleText = toggleGamesBtn.querySelector(".toggle-text");
		if (toggleText) {
			toggleText.textContent = isHidden ? "Mostrar juegos" : "Ocultar juegos";
		}
		const icon = toggleGamesBtn.querySelector("svg");
		if (icon) {
			icon.style.transform = isHidden ? "rotate(180deg)" : "rotate(0deg)";
		}
	});
}
