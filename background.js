// ============================================
// DOTTI SENDER FULL - BACKGROUND v3.1.1
// Copyright (c) DottiFlow - Todos os direitos reservados
// PROTECAO: SELETORES VEM DO SERVIDOR
// ============================================

importScripts("lib/dottiflow-sdk.js");

const CONFIG = {
    productSlug: "dotti-sender-full",
    apiUrl: "https://dottiflow.com.br/api/v1",
    debug: false
};

const WINDOW_SIZES = {
    mini: { width: 800, height: 600 },
    normal: { width: 1200, height: 800 }
};

let sdk = null;
let isInitialized = false;
let veoWindowId = null;
let isWindowMini = false;
let _backgroundModeActive = true; // Segundo plano: true=mini window+overlay, false=maximizado

// ============================================
// PROTECAO: CONFIG/SELETORES DO SERVIDOR
// ============================================
let _serverConfig = null;
let _configExpiry = 0;
let _sessionToken = null;

async function _fetchServerConfig() {
    try {
        const licenseData = await chrome.storage.local.get('dottiflow_license');
        const licenseKey = licenseData.dottiflow_license?.key;
        if (!licenseKey || !sdk?.deviceId) return null;

        const response = await fetch(`${CONFIG.apiUrl}/extension/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Product-Slug': CONFIG.productSlug },
            body: JSON.stringify({
                license_key: licenseKey,
                device_id: sdk.deviceId,
                product_slug: CONFIG.productSlug,
                session_token: _sessionToken,
                version: chrome.runtime.getManifest().version
            })
        });

        if (!response.ok) { _serverConfig = null; return null; }
        const data = await response.json();
        if (!data.success || !data.config) { _serverConfig = null; return null; }

        _serverConfig = data.config;
        _configExpiry = Date.now() + (data.ttl || 1800) * 1000;
        _sessionToken = data.session_token || _sessionToken;
        console.log("[Dotti] Config loaded from server");
        return _serverConfig;
    } catch (e) {
        console.error("[Dotti] Config fetch error:", e);
        _serverConfig = null;
        return null;
    }
}

async function _ensureConfig() {
    if (_serverConfig && _configExpiry > Date.now()) return _serverConfig;
    return await _fetchServerConfig();
}

// ============================================
// SISTEMA DE FILA - v3.0.0 COM ESTADO COMPLETO
// ============================================
let promptQueue = [];
let processedPrompts = [];
let queueSettings = { promptDelay: 3000, batchSize: 20, batchInterval: 90000 };
let currentBatchCount = 0;
let queuePaused = false;
let isProcessingQueue = false;
let targetTabId = null;
let totalProcessed = 0;
let lastActivityTime = 0;
let queueMediaType = "video";
let firstPromptOfBatch = true;

// v3.0.0: API interception tracking
let _mediaIdToPrompt = {};

// v3.0.0: Flag para evitar que background.js execute prompts quando content.js esta no controle
let _delegatedToContentJs = false;

// v3.2.5: Protect download filenames from other extensions
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    // Only protect downloads initiated by this extension
    if (downloadItem.byExtensionId === chrome.runtime.id) {
        suggest({ filename: downloadItem.filename, conflictAction: 'uniquify' });
    }
});

// ============================================
// SESSION STATE BACKUP — survive service worker restarts
// ============================================
async function saveStateToSession() {
    try {
        await chrome.storage.session.set({
            _ss_promptQueue: promptQueue,
            _ss_processedPrompts: processedPrompts,
            _ss_isProcessingQueue: isProcessingQueue,
            _ss_queuePaused: queuePaused,
            _ss_targetTabId: targetTabId,
            _ss_delegatedToContentJs: _delegatedToContentJs,
            _ss_totalProcessed: totalProcessed,
            _ss_lastActivityTime: lastActivityTime,
            _ss_queueMediaType: queueMediaType,
            _ss_currentBatchCount: currentBatchCount,
            _ss_firstPromptOfBatch: firstPromptOfBatch,
            _ss_veoWindowId: veoWindowId,
            _ss_isWindowMini: isWindowMini,
            _ss_backgroundModeActive: _backgroundModeActive,
            _ss_sessionToken: _sessionToken,
            _ss_queueSettings: queueSettings,
            _ss_mediaIdToPrompt: _mediaIdToPrompt
        });
    } catch (e) {
        console.log("[Dotti] saveStateToSession error:", e.message);
    }
}

async function restoreStateFromSession() {
    try {
        const s = await chrome.storage.session.get([
            '_ss_promptQueue', '_ss_processedPrompts', '_ss_isProcessingQueue',
            '_ss_queuePaused', '_ss_targetTabId', '_ss_delegatedToContentJs',
            '_ss_totalProcessed', '_ss_lastActivityTime', '_ss_queueMediaType',
            '_ss_currentBatchCount', '_ss_firstPromptOfBatch',
            '_ss_veoWindowId', '_ss_isWindowMini',
            '_ss_backgroundModeActive', '_ss_sessionToken',
            '_ss_queueSettings', '_ss_mediaIdToPrompt'
        ]);
        if (s._ss_targetTabId !== undefined) targetTabId = s._ss_targetTabId;
        if (s._ss_promptQueue !== undefined) promptQueue = s._ss_promptQueue;
        if (s._ss_processedPrompts !== undefined) processedPrompts = s._ss_processedPrompts;
        if (s._ss_isProcessingQueue !== undefined) isProcessingQueue = s._ss_isProcessingQueue;
        if (s._ss_queuePaused !== undefined) queuePaused = s._ss_queuePaused;
        if (s._ss_delegatedToContentJs !== undefined) _delegatedToContentJs = s._ss_delegatedToContentJs;
        if (s._ss_totalProcessed !== undefined) totalProcessed = s._ss_totalProcessed;
        if (s._ss_lastActivityTime !== undefined) lastActivityTime = s._ss_lastActivityTime;
        if (s._ss_queueMediaType !== undefined) queueMediaType = s._ss_queueMediaType;
        if (s._ss_currentBatchCount !== undefined) currentBatchCount = s._ss_currentBatchCount;
        if (s._ss_firstPromptOfBatch !== undefined) firstPromptOfBatch = s._ss_firstPromptOfBatch;
        if (s._ss_veoWindowId !== undefined) veoWindowId = s._ss_veoWindowId;
        if (s._ss_isWindowMini !== undefined) isWindowMini = s._ss_isWindowMini;
        if (s._ss_backgroundModeActive !== undefined) _backgroundModeActive = s._ss_backgroundModeActive;
        if (s._ss_sessionToken !== undefined) _sessionToken = s._ss_sessionToken;
        if (s._ss_queueSettings !== undefined) queueSettings = s._ss_queueSettings;
        if (s._ss_mediaIdToPrompt !== undefined) _mediaIdToPrompt = s._ss_mediaIdToPrompt;
        console.log("[Dotti] Session state restored. Queue:", promptQueue.length, "Processing:", isProcessingQueue);
    } catch (e) {
        console.log("[Dotti] restoreStateFromSession error:", e.message);
    }
}

// Restore session state immediately on service worker start
restoreStateFromSession();

// ============================================
// SDK INITIALIZATION
// ============================================
async function initSDK() {
    sdk = new DottiFlowSDK(CONFIG.productSlug, {
        apiUrl: CONFIG.apiUrl,
        debug: CONFIG.debug,
        onLicenseValid: async () => { setBadgeStatus("active"); await _fetchServerConfig(); },
        onLicenseInvalid: () => { _serverConfig = null; setBadgeStatus("inactive"); }
    });
    const valid = await sdk.init();
    isInitialized = true;
    setBadgeStatus(valid ? "active" : "inactive");
    if (valid) await _fetchServerConfig();
    return valid;
}

function setBadgeStatus(status) {
    if (status === "active") {
        chrome.action.setBadgeText({ text: "" });
        chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    } else if (status === "processing") {
        chrome.action.setBadgeText({ text: "\u25b6" });
        chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
    } else {
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    }
}

// ============================================
// WINDOW MANAGEMENT (restaurado do v2.0.0)
// ============================================
async function openVeoWindow(mini = true) {
    let win;
    if (mini) {
        const size = WINDOW_SIZES.mini;
        const displays = await chrome.system.display.getInfo();
        const pd = displays[0];
        win = await chrome.windows.create({
            url: "https://labs.google/fx/tools/flow",
            type: "popup",
            width: size.width,
            height: size.height,
            left: pd.workArea.width - size.width - 20,
            top: pd.workArea.height - size.height - 20,
            focused: true
        });
        isWindowMini = true;
    } else {
        win = await chrome.windows.create({
            url: "https://labs.google/fx/tools/flow",
            type: "popup",
            state: "maximized",
            focused: true
        });
        isWindowMini = false;
    }
    veoWindowId = win.id;
    if (win.tabs?.[0]) {
        targetTabId = win.tabs[0].id;
        await chrome.storage.local.set({ veoWindowId, veoTabId: targetTabId, isWindowMini });
    }
    return win;
}

async function toggleWindowSize() {
    if (!veoWindowId) return { success: false, error: "no_window" };
    try {
        isWindowMini = !isWindowMini;
        if (isWindowMini) {
            const size = WINDOW_SIZES.mini;
            const displays = await chrome.system.display.getInfo();
            const pd = displays[0];
            await chrome.windows.update(veoWindowId, {
                state: "normal",
                width: size.width,
                height: size.height,
                left: pd.workArea.width - size.width - 20,
                top: pd.workArea.height - size.height - 20
            });
            if (isProcessingQueue) {
                await injectStatusOverlay();
                await updateStatusOverlay("Processando...", totalProcessed, totalProcessed + promptQueue.length);
            }
        } else {
            await chrome.windows.update(veoWindowId, {
                state: "maximized"
            });
            await removeStatusOverlay();
        }
        await chrome.storage.local.set({ isWindowMini });
        return { success: true, isMini: isWindowMini };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function focusVeoWindow() {
    if (!veoWindowId) return;
    try {
        if (isWindowMini && isProcessingQueue) {
            await chrome.windows.update(veoWindowId, { drawAttention: false });
        } else {
            await chrome.windows.update(veoWindowId, { focused: true });
        }
    } catch (e) {
        veoWindowId = null;
    }
}

chrome.windows.onRemoved.addListener((id) => {
    if (id === veoWindowId) {
        veoWindowId = null;
        targetTabId = null;
        chrome.storage.local.remove(['veoWindowId', 'veoTabId']);
    }
});

// Detectar quando usuario maximiza/redimensiona a janela manualmente
chrome.windows.onBoundsChanged.addListener(async (win) => {
    if (win.id !== veoWindowId) return;
    try {
        const w = await chrome.windows.get(win.id);
        const isBig = w.state === 'maximized' || w.state === 'fullscreen' ||
            (w.width > WINDOW_SIZES.mini.width + 100 && w.height > WINDOW_SIZES.mini.height + 100);
        if (isBig && isWindowMini) {
            isWindowMini = false;
            await chrome.storage.local.set({ isWindowMini: false });
            await removeStatusOverlay();
        } else if (!isBig && !isWindowMini && _delegatedToContentJs) {
            isWindowMini = true;
            await chrome.storage.local.set({ isWindowMini: true });
            await injectStatusOverlay();
        }
    } catch (e) {}
});

// v3.1.1: Alarm dedicado para monitorar janela durante processamento (one-shot recursivo = ~5s)
function startWindowGuard() {
    chrome.alarms.create("dottiWindowGuard", { delayInMinutes: 0.08 }); // ~5 segundos
}
function stopWindowGuard() {
    chrome.alarms.clear("dottiWindowGuard");
}

// ============================================
// STATUS OVERLAY (restaurado do v2.0.0)
// ============================================
// Ultimo estado do overlay para restaurar ao re-minimizar
let _lastOverlayStatus = 'Preparando...';
let _lastOverlaySent = 0;
let _lastOverlayTotal = 0;

async function injectStatusOverlay() {
    if (!targetTabId) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (iconUrl, status, sent, total) => {
                document.getElementById("dotti-status-overlay")?.remove();
                let link = document.querySelector("link[rel*='icon']");
                if (!link) {
                    link = document.createElement('link');
                    link.rel = 'icon';
                    document.head.appendChild(link);
                }
                link.href = iconUrl;
                document.title = "Dotti Sender FULL";
                // Esconder TUDO da pagina
                document.body.style.setProperty('visibility', 'hidden', 'important');
                const o = document.createElement("div");
                o.id = "dotti-status-overlay";
                const pct = total > 0 ? (sent / total) * 100 : 0;
                o.innerHTML = '<style>*{margin:0;padding:0}#dotti-status-overlay{position:fixed!important;top:0!important;left:0!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;background:linear-gradient(135deg,#1a1a2e,#16213e)!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;font-family:Segoe UI,Arial,sans-serif!important;color:#fff!important;pointer-events:none!important;visibility:visible!important;overflow:hidden!important}#dotti-status-overlay .logo{font-size:40px;margin-bottom:12px}#dotti-status-overlay .title{font-size:18px;font-weight:700;margin-bottom:6px;background:linear-gradient(90deg,#00d4ff,#7b2cbf);-webkit-background-clip:text;-webkit-text-fill-color:transparent;white-space:nowrap}#dotti-status-overlay .status{font-size:12px;color:#a0a0a0;margin-bottom:14px;text-align:center}#dotti-status-overlay .pbar{width:60%;max-width:240px;height:5px;background:#2a2a4a;border-radius:3px;overflow:hidden;margin-bottom:10px}#dotti-status-overlay .pfill{height:100%;background:linear-gradient(90deg,#00d4ff,#7b2cbf);border-radius:3px;transition:width .3s}#dotti-status-overlay .count{font-size:28px;font-weight:700;color:#00d4ff}#dotti-status-overlay .label{font-size:10px;color:#666;margin-top:4px}</style><div class="logo">&#9889;</div><div class="title">DOTTI SENDER FULL</div><div class="status" id="dso-status">' + status + '</div><div class="pbar"><div class="pfill" id="dso-progress" style="width:' + pct + '%"></div></div><div class="count" id="dso-count">' + sent + '/' + total + '</div><div class="label">prompts enviados</div>';
                document.documentElement.appendChild(o);
            },
            args: [chrome.runtime.getURL("icons/icon128.png"), _lastOverlayStatus, _lastOverlaySent, _lastOverlayTotal]
        });
    } catch (e) { }
}

async function updateStatusOverlay(status, current, total) {
    _lastOverlayStatus = status;
    _lastOverlaySent = current;
    _lastOverlayTotal = total;
    if (!targetTabId || !isWindowMini) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (s, c, t) => {
                const st = document.getElementById("dso-status");
                const pr = document.getElementById("dso-progress");
                const ct = document.getElementById("dso-count");
                if (st) st.textContent = s;
                if (ct) ct.textContent = c + "/" + t;
                if (pr) pr.style.width = (t > 0 ? (c / t) * 100 : 0) + "%";
            },
            args: [status, current, total]
        });
    } catch (e) { }
}

async function removeStatusOverlay() {
    if (!targetTabId) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                document.getElementById("dotti-status-overlay")?.remove();
                document.body.style.removeProperty('visibility');
                document.documentElement.style.removeProperty('visibility');
            }
        });
    } catch (e) { }
}

// ============================================
// QUEUE PERSISTENCE - v3.0.0 ESTADO COMPLETO
// ============================================
async function saveQueueState() {
    // v3.5.0: Strip imageDataUrl from prompts before saving to avoid QUOTA_BYTES exceeded
    // Frame images as base64 can be several MB each, easily exceeding chrome.storage.local limits
    var queueToSave = promptQueue.map(function(p) {
        if (p.imageDataUrl) {
            var copy = Object.assign({}, p);
            delete copy.imageDataUrl;
            copy._hadImage = true; // Flag to know image was stripped
            return copy;
        }
        return p;
    });
    await chrome.storage.local.set({
        dottiQueue: queueToSave,
        dottiProcessedPrompts: processedPrompts,
        dottiSettings: queueSettings,
        dottiBatchCount: currentBatchCount,
        dottiPaused: queuePaused,
        dottiTabId: targetTabId,
        dottiProcessing: isProcessingQueue,
        dottiTotalProcessed: totalProcessed,
        dottiLastActivity: lastActivityTime,
        dottiMediaType: queueMediaType
    });
    // Also backup to session storage for service worker restart survival
    saveStateToSession();
}

async function loadQueueState() {
    const data = await chrome.storage.local.get([
        'dottiQueue', 'dottiProcessedPrompts', 'dottiSettings', 'dottiBatchCount',
        'dottiPaused', 'dottiTabId', 'dottiProcessing', 'dottiTotalProcessed',
        'dottiLastActivity', 'dottiMediaType', 'veoTabId', 'veoWindowId', 'isWindowMini'
    ]);
    if (data.veoWindowId) {
        veoWindowId = data.veoWindowId;
    }
    isWindowMini = data.isWindowMini !== false;
    if (data.veoTabId) {
        targetTabId = data.veoTabId;
    }
    if (data.dottiQueue?.length > 0) {
        promptQueue = data.dottiQueue;
        processedPrompts = data.dottiProcessedPrompts || [];
        queueSettings = data.dottiSettings || queueSettings;
        currentBatchCount = data.dottiBatchCount || 0;
        queuePaused = data.dottiPaused || false;
        totalProcessed = data.dottiTotalProcessed || 0;
        lastActivityTime = data.dottiLastActivity || 0;
        queueMediaType = data.dottiMediaType || "video";
        isProcessingQueue = data.dottiProcessing || false;
        return true;
    }
    // Restaurar processedPrompts mesmo sem fila ativa
    if (data.dottiProcessedPrompts?.length > 0) {
        processedPrompts = data.dottiProcessedPrompts;
        totalProcessed = data.dottiTotalProcessed || 0;
    }
    return false;
}

async function clearQueueState() {
    promptQueue = [];
    processedPrompts = [];
    currentBatchCount = 0;
    isProcessingQueue = false;
    queuePaused = false;
    totalProcessed = 0;
    lastActivityTime = 0;
    queueMediaType = "video";
    await chrome.storage.local.remove([
        'dottiQueue', 'dottiProcessedPrompts', 'dottiSettings', 'dottiBatchCount',
        'dottiPaused', 'dottiTabId', 'dottiProcessing', 'dottiTotalProcessed',
        'dottiLastActivity', 'dottiMediaType'
    ]);
    saveStateToSession();
}

async function notifyTab(message, retries = 2) {
    if (!targetTabId) return;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            await chrome.tabs.sendMessage(targetTabId, message);
            return;
        } catch (e) {
            const errMsg = String(e.message || e);
            if (attempt < retries && (errMsg.includes('Could not establish connection') || errMsg.includes('Receiving end does not exist'))) {
                await sleep(400 * (attempt + 1));
                continue;
            }
            // Tab fechada ou content script nao carregado — nao e critico
        }
    }
}

// ============================================
// HELPERS
// ============================================
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitForCondition(tabId, conditionFn, args, timeout = 10000, interval = 300) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        try {
            const result = await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: conditionFn,
                args: args || []
            });
            if (result?.[0]?.result) return true;
        } catch (e) {
            // Tab pode nao estar pronta ainda
        }
        await sleep(interval);
    }
    return false;
}

// ============================================
// EXECUTE PROMPT - v3.0.0
// ============================================
async function executePromptInTab(prompt, mediaType) {
    const config = await _ensureConfig();
    if (!config) {
        console.log("[Dotti] BLOCKED: No server config");
        return { success: false, error: "no_config", blocked: true };
    }

    console.log("[Dotti] Executing prompt", prompt.number);
    lastActivityTime = Date.now();

    // v3.0.0: Esperar pagina estar pronta (contenteditable textbox visivel)
    const pageReady = await waitForCondition(targetTabId, function () {
        const ta = document.querySelector("[role='textbox']");
        return ta && ta.offsetParent !== null;
    }, [], 15000, 500);

    if (!pageReady) {
        console.log("[Dotti] Page not ready after 15s");
        return { success: false, error: "page_not_ready" };
    }

    await sleep(200);

    const hasElements = prompt.elements?.length > 0;

    // Setup de output count so no PRIMEIRO prompt do lote
    if (firstPromptOfBatch) {
        console.log("[Dotti] Primeiro prompt - setup output count");

        const outCount = queueSettings.outputCount || 1;
        if (outCount > 1) {
            console.log("[Dotti] Definindo outputs per prompt =", outCount);
            try {
                const setResult = await Promise.race([
                    chrome.tabs.sendMessage(targetTabId, {
                        action: "SET_OUTPUTS_PER_PROMPT",
                        count: outCount
                    }),
                    sleep(10000).then(() => ({ timeout: true }))
                ]);
                console.log("[Dotti] SET_OUTPUTS_PER_PROMPT result:", JSON.stringify(setResult));
                await sleep(1000);
            } catch (e) {
                console.log("[Dotti] SET_OUTPUTS_PER_PROMPT failed:", e.message);
            }
        }

        firstPromptOfBatch = false;
        console.log("[Dotti] Setup completo - prosseguindo com prompt");
    }

    // Delay de seguranca antes dos steps
    await sleep(800);

    console.log("[Dotti] Iniciando steps 1-5 (mode=" + mediaType + ", hasElements=" + hasElements + ")");

    try {
        // 1. Trocar modo Video/Imagem
        console.log("[Dotti] Step 1: selecionando modo", mediaType);

        const simulateClickScript = `
            window.__dottiClick = function(el) {
                const rect = el.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, detail: 1 };
                el.dispatchEvent(new PointerEvent("pointerover", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new PointerEvent("pointerenter", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new MouseEvent("mouseover", opts));
                el.dispatchEvent(new MouseEvent("mouseenter", opts));
                el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new MouseEvent("mousedown", opts));
                el.focus && el.focus();
                el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new MouseEvent("mouseup", opts));
                el.dispatchEvent(new MouseEvent("click", opts));
            };
        `;
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (script) => { eval(script); },
            args: [simulateClickScript]
        });

        // Step 1a: Abrir seletor de modo
        const openResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                const tb = document.querySelector("[role='textbox']");
                if (!tb) return { found: false, reason: "no_textbox" };
                const tbY = tb.getBoundingClientRect().top;
                let modeBtn = null;
                let modeBtnText = "";
                document.querySelectorAll("button").forEach(b => {
                    if (b.offsetParent === null) return;
                    const r = b.getBoundingClientRect();
                    if (Math.abs(r.top - tbY) < 100 && r.width > 60 && r.width < 200) {
                        const t = b.textContent.toLowerCase();
                        if (t.indexOf("crop") >= 0 || t.indexOf("videocam") >= 0 || t.indexOf("movie") >= 0 || t.indexOf("image") >= 0 || t.indexOf("video") >= 0) {
                            modeBtn = b;
                            modeBtnText = t;
                        }
                    }
                });
                if (!modeBtn) return { found: false, reason: "no_mode_btn" };
                window.__dottiClick(modeBtn);
                return { found: true, text: modeBtnText };
            }
        });
        const or = openResult?.[0]?.result;
        console.log("[Dotti] Step 1a open selector:", JSON.stringify(or));
        await sleep(1200);

        // Step 1b: Clicar na tab do modo correto
        const modeResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (targetMode) => {
                const tabs = document.querySelectorAll('button[role="tab"]');
                const allTabTexts = Array.from(tabs).map(t => ({
                    text: t.textContent.trim().toLowerCase(),
                    visible: t.offsetParent !== null,
                    selected: t.getAttribute("aria-selected")
                }));
                let targetTab = null;
                for (const tab of tabs) {
                    if (tab.offsetParent === null) continue;
                    const t = tab.textContent.trim().toLowerCase();
                    if (targetMode === "image" && t === "imageimage") { targetTab = tab; break; }
                    if (targetMode === "video" && t === "videocamvideo") { targetTab = tab; break; }
                }
                if (!targetTab) {
                    for (const tab of tabs) {
                        if (tab.offsetParent === null) continue;
                        const t = tab.textContent.trim().toLowerCase();
                        if (targetMode === "image" && t.indexOf("image") >= 0 && t.indexOf("view") < 0) { targetTab = tab; break; }
                        if (targetMode === "video" && t.indexOf("video") >= 0 && t.indexOf("view") < 0) { targetTab = tab; break; }
                    }
                }
                if (!targetTab) {
                    return { clicked: false, tabs: allTabTexts };
                }
                const wasSel = targetTab.getAttribute("aria-selected");
                window.__dottiClick(targetTab);
                const nowSel = targetTab.getAttribute("aria-selected");
                return { clicked: true, tab: targetTab.textContent.trim(), before: wasSel, after: nowSel, allTabs: allTabTexts };
            },
            args: [mediaType]
        });
        const mr = modeResult?.[0]?.result;
        console.log("[Dotti] Step 1b tab click:", JSON.stringify(mr));
        await sleep(1000);

        // Fechar seletor clicando no textbox
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                const tb = document.querySelector("[role='textbox']");
                if (tb) window.__dottiClick(tb);
            }
        });
        await sleep(500);
        console.log("[Dotti] Step 1 modo selecionado:", mediaType);

        // 2. Clear elements anexados ao prompt (APENAS perto do textbox, NAO na galeria)
        try {
            await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: () => {
                    const ta = document.querySelector("[role='textbox']");
                    if (!ta) return;
                    const taRect = ta.getBoundingClientRect();

                    document.querySelectorAll("button").forEach(btn => {
                        if (btn.offsetParent === null) return;
                        const icon = btn.querySelector("i");
                        if (!icon) return;
                        const iconText = icon.textContent?.trim();
                        if (iconText !== "close" && iconText !== "clear") return;

                        const btnRect = btn.getBoundingClientRect();
                        if (Math.abs(btnRect.top - taRect.top) > 200) return;

                        const parent = btn.parentElement;
                        if (!parent || !parent.querySelector("img")) return;

                        console.log("[Dotti DOM] Removendo elemento anexado ao prompt");
                        btn.click();
                    });
                }
            });
        } catch (e) {
            console.log("[Dotti] Step 2 clear error (non-fatal):", e.message);
        }
        await sleep(600);

        // 3. Add elements (referencias da galeria) ou Frame upload
        if (mediaType === "frame" && prompt.imageDataUrl) {
            console.log("[Dotti] Step 3: Frame Upload (image to video)");

            const uploadResult = await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: async (dataUrl, imageName) => {
                    const wait = ms => new Promise(r => setTimeout(r, ms));
                    const click = async (el) => {
                        if (!el) return;
                        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
                        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    };

                    try {
                        const fetchResp = await fetch(dataUrl);
                        const blob = await fetchResp.blob();
                        const file = new File([blob], imageName, { type: 'image/png' });

                        const fileInput = document.querySelector('input[type="file"][accept*="image"]') || document.querySelector('input[type="file"]');
                        if (!fileInput) return { success: false, step: "no_input" };

                        fileInput.value = '';
                        const dt = new DataTransfer();
                        dt.items.add(file);
                        fileInput.files = dt.files;
                        fileInput.dispatchEvent(new Event('change', { bubbles: true }));

                        await wait(2500);

                        let startBtn = null;
                        const emptySlots = document.querySelectorAll('div[class*="sc-8f31d1ba-1"], div[type="button"][aria-haspopup="dialog"]');
                        for (const slot of emptySlots) {
                            const text = (slot.textContent || '').trim().toLowerCase();
                            if (text === 'start' || text === 'início' || text === 'inicio') { startBtn = slot; break; }
                        }
                        if (!startBtn) {
                            const divBtns = document.querySelectorAll('div[type="button"]');
                            for (const div of divBtns) {
                                const text = (div.textContent || '').trim().toLowerCase();
                                if (text === 'start' || text === 'início' || text === 'inicio') { startBtn = div; break; }
                            }
                        }
                        if (!startBtn) return { success: false, step: "no_start_btn" };
                        await click(startBtn);
                        await wait(1500);

                        const dialog = document.querySelector('[role="dialog"][data-state="open"]') || document.querySelector('[role="dialog"]');
                        if (!dialog) return { success: false, step: "no_dialog" };

                        const sortBtns = dialog.querySelectorAll('button');
                        for (const btn of sortBtns) {
                            const text = (btn.textContent || '').trim().toLowerCase();
                            if (text.includes('recently') || text.includes('newest') || text.includes('oldest') || text.includes('most used') || text.includes('recente') || text.includes('antigo')) {
                                if (!text.includes('newest') && !text.includes('recente')) {
                                    await click(btn);
                                    await wait(800);
                                    const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], [data-radix-collection-item]');
                                    for (const item of menuItems) {
                                        if ((item.textContent || '').trim().toLowerCase().includes('newest') || (item.textContent || '').trim().toLowerCase().includes('recente')) {
                                            await click(item);
                                            await wait(800);
                                            break;
                                        }
                                    }
                                }
                                break;
                            }
                        }

                        const searchInput = dialog.querySelector('input[type="text"]') || dialog.querySelector('input[placeholder*="Search"]') || dialog.querySelector('input');
                        if (searchInput) {
                            searchInput.focus();
                            searchInput.value = '';
                            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                            await wait(300);
                            searchInput.value = imageName;
                            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                            searchInput.dispatchEvent(new Event('change', { bubbles: true }));
                            await wait(1500);
                        }

                        let assetSelected = false;
                        let searchWait = 10000;
                        while (searchWait > 0 && !assetSelected) {
                            const currentDialog = document.querySelector('[role="dialog"]');
                            if (!currentDialog) { assetSelected = true; break; }

                            const assetItems = currentDialog.querySelectorAll('[class*="sc-5bf79b14"]');
                            const assetImgs = currentDialog.querySelectorAll('img[src*="getMediaUrlRedirect"]');

                            if (assetItems.length > 0 || assetImgs.length > 0) {
                                let clickTarget = assetItems.length > 0 ? assetItems[0] : (assetImgs[0].closest('[class*="sc-5bf79b14"]') || assetImgs[0]);
                                await click(clickTarget);
                                await wait(1000);
                                if (!document.querySelector('[role="dialog"]')) { assetSelected = true; break; }

                                if (assetImgs.length > 0) {
                                    await click(assetImgs[0]);
                                    await wait(1000);
                                    if (!document.querySelector('[role="dialog"]')) { assetSelected = true; break; }
                                }
                            }
                            await wait(500);
                            searchWait -= 500;
                        }
                        if (!assetSelected) {
                            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                            return { success: false, step: "no_asset_selected" };
                        }
                        return { success: true };
                    } catch (e) {
                        return { success: false, step: e.message };
                    }
                },
                args: [prompt.imageDataUrl, prompt.imageName]
            });
            const upRes = uploadResult?.[0]?.result;
            if (!upRes || !upRes.success) {
                console.log("[Dotti] Frame upload failed at step:", upRes?.step);
                return { success: false, error: "frame_upload_failed" };
            }
            await sleep(1500);

        } else if (hasElements) {
            const selectedOriginalIndices = [];
            for (const elementNum of prompt.elements) {
                const openResult = await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const allBtns = [...document.querySelectorAll("button")].filter(b => b.offsetParent !== null);
                        let addBtn = allBtns.find(b => {
                            const icon = b.querySelector("i");
                            return icon && icon.textContent.trim() === "add_2";
                        });
                        if (!addBtn) {
                            const tb = document.querySelector("[role='textbox']");
                            const tbY = tb ? tb.getBoundingClientRect().top : 0;
                            addBtn = allBtns.find(b => {
                                const icon = b.querySelector("i");
                                if (!icon) return false;
                                const t = icon.textContent.trim().toLowerCase();
                                if (t !== "add" && t !== "add_circle" && t !== "add_photo_alternate") return false;
                                return Math.abs(b.getBoundingClientRect().top - tbY) < 200;
                            });
                        }
                        if (!addBtn) { console.log("[Dotti DOM] Botao add galeria NAO encontrado"); return false; }
                        console.log("[Dotti DOM] Clicando add_2 via .click()");
                        addBtn.click();
                        return true;
                    }
                });
                if (!openResult?.[0]?.result) {
                    console.log("[Dotti] gallery_failed for element", elementNum);
                    return { success: false, error: "gallery_failed" };
                }

                await waitForCondition(targetTabId, function () {
                    return document.querySelectorAll('[role="dialog"] img').length > 0 ||
                        document.querySelectorAll('[data-state="open"] img').length > 0;
                }, [], 8000, 300);
                await sleep(500);

                // Ordenar por "Mais antigo" (Oldest)
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const dialog = document.querySelector('[role="dialog"]');
                        if (!dialog) return;
                        let sortBtn = null;
                        dialog.querySelectorAll("button").forEach(b => {
                            if (b.textContent.indexOf("arrow_drop_down") >= 0) sortBtn = b;
                        });
                        if (!sortBtn) { console.log("[Dotti DOM] Sort btn nao encontrado"); return; }
                        if (sortBtn.textContent.indexOf("antigo") >= 0 || sortBtn.textContent.indexOf("ldest") >= 0) {
                            console.log("[Dotti DOM] Ja esta em Mais antigo");
                            return;
                        }
                        console.log("[Dotti DOM] Abrindo sort dropdown...");
                        sortBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
                        sortBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
                        sortBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                    }
                });
                await sleep(1000);

                // Clicar em "Mais antigo" / "Oldest"
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const items = document.querySelectorAll('[role="menuitem"], [data-radix-collection-item]');
                        for (const item of items) {
                            const t = item.textContent.trim();
                            if (t.indexOf("antigo") >= 0 || t.indexOf("ldest") >= 0) {
                                console.log("[Dotti DOM] Selecionando:", t);
                                item.click();
                                return;
                            }
                        }
                        document.querySelectorAll("div, span, button, li, a").forEach(el => {
                            const t = el.textContent.trim();
                            const r = el.getBoundingClientRect();
                            if (r.width > 0 && r.height > 10 && r.width < 300 && t.length < 30) {
                                if ((t.indexOf("antigo") >= 0 || t === "Oldest") && el.children.length === 0) {
                                    console.log("[Dotti DOM] Selecionando (fallback):", t);
                                    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
                                    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
                                    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
                                }
                            }
                        });
                    }
                });
                await sleep(1500);

                const originalIdx = elementNum - 1;
                let adjustedIdx = originalIdx;
                for (const prevIdx of selectedOriginalIndices) {
                    if (prevIdx < originalIdx) adjustedIdx--;
                }
                console.log("[Dotti] Element", elementNum, "-> originalIdx:", originalIdx, "adjustedIdx:", adjustedIdx, "prevSelected:", selectedOriginalIndices);

                const selectResult = await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: (idx) => {
                        const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[data-state="open"]');
                        if (!dialog) { console.log("[Dotti DOM] Dialog nao encontrado"); return false; }
                        const imgs = dialog.querySelectorAll("img");
                        console.log("[Dotti DOM] Gallery imgs:", imgs.length, "selecting idx:", idx);
                        if (idx < imgs.length) {
                            imgs[idx].click();
                            return true;
                        }
                        console.log("[Dotti DOM] Indice", idx, "fora do range (max:", imgs.length - 1, ")");
                        return false;
                    },
                    args: [adjustedIdx]
                });
                if (!selectResult?.[0]?.result) return { success: false, error: "element_select_failed" };
                selectedOriginalIndices.push(originalIdx);
                await sleep(1500);

                // Fechar dialog se ainda estiver aberto
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const dialog = document.querySelector('[role="dialog"]');
                        if (!dialog) return;
                        const btns = dialog.querySelectorAll("button");
                        for (const btn of btns) {
                            const icon = btn.querySelector("i");
                            const t = icon ? icon.textContent.trim() : "";
                            if (t === "close" || t === "done" || t === "check") {
                                btn.click();
                                return;
                            }
                        }
                        const overlay = dialog.parentElement;
                        if (overlay && overlay !== document.body) {
                            overlay.click();
                        }
                    }
                });
                await sleep(800);
            }
        }

        // 4. Fill textbox via Slate API
        console.log("[Dotti] Step 4: fill textbox via Slate API");
        const fillResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (text) => {
                const ta = document.querySelector("[role='textbox']");
                if (!ta) { console.log("[Dotti DOM] textbox NOT FOUND"); return false; }
                const fk = Object.keys(ta).find(k => k.startsWith("__reactFiber$"));
                if (!fk) { console.log("[Dotti DOM] React fiber NOT FOUND"); return false; }
                let fiber = ta[fk], editor = null;
                for (let i = 0; i < 50 && fiber; i++) {
                    if (fiber.memoizedProps?.editor?.insertText) { editor = fiber.memoizedProps.editor; break; }
                    if (fiber.memoizedProps?.value?.insertText) { editor = fiber.memoizedProps.value; break; }
                    fiber = fiber.return;
                }
                if (!editor) { console.log("[Dotti DOM] Slate editor NOT FOUND"); return false; }
                editor.withoutNormalizing(() => {
                    try {
                        editor.select({ anchor: editor.start([]), focus: editor.end([]) });
                        editor.deleteFragment();
                    } catch (e) { }
                    editor.insertText(text);
                });
                console.log("[Dotti DOM] Slate filled:", editor.children[0]?.children[0]?.text?.substring(0, 50));
                return true;
            },
            args: [prompt.text]
        });
        if (!fillResult?.[0]?.result) return { success: false, error: "fill_failed" };

        await waitForCondition(targetTabId, function () {
            const ta = document.querySelector("[role='textbox']");
            if (!ta) return false;
            const text = ta.textContent || "";
            return text.length > 30 || (text.length > 0 && !text.includes("O que voc"));
        }, [], 5000, 300);
        await sleep(500);

        // 5. Click submit
        console.log("[Dotti] Step 5: submit");
        const clickResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                for (const btn of document.querySelectorAll("button")) {
                    if (btn.offsetParent === null) continue;
                    const icon = btn.querySelector("i");
                    if (icon?.textContent?.trim() === "arrow_forward") {
                        console.log("[Dotti DOM] Submit btn found");
                        btn.click();
                        return true;
                    }
                }
                console.log("[Dotti DOM] Submit button NOT FOUND");
                return false;
            }
        });
        if (!clickResult?.[0]?.result) return { success: false, error: "submit_failed" };

        const submitted = await waitForCondition(targetTabId, function () {
            const ta = document.querySelector("[role='textbox']");
            if (!ta) return true;
            const text = ta.textContent || "";
            if (text.includes("O que voc") && text.length < 40) return true;
            if (text.trim().length === 0) return true;
            for (const btn of document.querySelectorAll("button")) {
                const icon = btn.querySelector("i");
                if (icon?.textContent?.trim() === "arrow_forward" && btn.disabled) return true;
            }
            return false;
        }, [], 10000, 500);

        if (!submitted) {
            console.log("[Dotti] Submit not confirmed, retrying...");
            await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: () => {
                    for (const btn of document.querySelectorAll("button")) {
                        if (btn.offsetParent === null) continue;
                        if (btn.querySelector("i")?.textContent?.trim() === "arrow_forward") {
                            btn.click();
                            return true;
                        }
                    }
                }
            });
            await sleep(2000);
        }

        console.log("[Dotti] Prompt", prompt.number, "OK");
        return { success: true };
    } catch (e) {
        console.error("[Dotti] Execute error:", e.message);
        return { success: false, error: e.message };
    }
}

// ============================================
// QUEUE PROCESSING - v3.0.0
// ============================================
async function processNextPrompt() {
    // v3.0.0: Se content.js esta no controle (slots), nao executar aqui
    if (_delegatedToContentJs) {
        console.log("[Dotti] processNextPrompt: delegated to content.js — skipping");
        return;
    }
    console.log("[Dotti] processNextPrompt called, queue:", promptQueue.length, "paused:", queuePaused, "processing:", isProcessingQueue);
    if (promptQueue.length === 0 || queuePaused) {
        if (promptQueue.length === 0 && isProcessingQueue && totalProcessed > 0) {
            isProcessingQueue = false;
            setBadgeStatus("active");
            try { await saveQueueState(); } catch (_sqe) { }
            await sleep(3000);
            await removeStatusOverlay();
            if (veoWindowId) {
                try {
                    await chrome.windows.update(veoWindowId, {
                        state: "maximized",
                        focused: true
                    });
                    isWindowMini = false;
                } catch (e) { }
            }
            notifyTab({ action: "QUEUE_COMPLETE", data: { total: totalProcessed } });
        }
        return;
    }

    isProcessingQueue = true;
    setBadgeStatus("processing");
    lastActivityTime = Date.now();

    const prompt = promptQueue[0];
    const totalInQueue = totalProcessed + promptQueue.length;

    await updateStatusOverlay("Enviando PROMPT " + prompt.number + "...", totalProcessed, totalInQueue);

    // v3.0.0: Limpar galeria/elementos antes de cada prompt
    try {
        await chrome.tabs.sendMessage(targetTabId, { action: "PREPARE_FOR_NEXT_PROMPT" });
        await sleep(800);
    } catch (e) { }

    notifyTab({ action: "PROMPT_STARTING", data: prompt });

    const result = await executePromptInTab(prompt, queueMediaType);
    console.log("[Dotti] Prompt", prompt.number, "result:", JSON.stringify(result));

    if (result.blocked) {
        isProcessingQueue = false;
        queuePaused = true;
        setBadgeStatus("inactive");
        await updateStatusOverlay("LICENCA INVALIDA", totalProcessed, totalInQueue);
        notifyTab({ action: "LICENSE_ERROR", data: { message: "Configuracao do servidor nao disponivel" } });
        try { await saveQueueState(); } catch (_sqe) { }
        return;
    }

    // Se janela/tab fechada, parar fila inteira
    if (!result.success && result.error === "window_closed") {
        isProcessingQueue = false;
        queuePaused = true;
        setBadgeStatus("active");
        notifyTab({ action: "QUEUE_ERROR", data: { message: "Janela do Veo foi fechada" } });
        try { await saveQueueState(); } catch (_sqe) { }
        return;
    }

    // Retry melhorado - maximo 3 tentativas com delay extra
    if (!result.success && (prompt.retryCount || 0) < 3) {
        prompt.retryCount = (prompt.retryCount || 0) + 1;
        console.log("[Dotti] Retry", prompt.retryCount, "for prompt", prompt.number, "error:", result.error);
        try { await saveQueueState(); } catch (_sqe) { }
        await sleep(3000);
        await processNextPrompt();
        return;
    }

    // Registrar resultado
    prompt.status = result.success ? "sent" : "error";
    if (!result.success) prompt.error = result.error;
    await updateStatusOverlay("PROMPT " + prompt.number + " enviado!", totalProcessed, totalInQueue);
    notifyTab({ action: "PROMPT_RESULT", data: { ...prompt, result } });

    // Log persistente de resultados
    logPromptResult(prompt, queueMediaType);

    // Mover para processedPrompts
    promptQueue.shift();
    processedPrompts.push({ ...prompt });
    currentBatchCount++;
    totalProcessed++;
    lastActivityTime = Date.now();

    try { await saveQueueState(); } catch (_sqe) { }

    if (promptQueue.length > 0 && !queuePaused) {
        let delay = queueSettings.promptDelay;
        if (currentBatchCount >= queueSettings.batchSize) {
            const batchDelay = queueMediaType === "video"
                ? Math.max(queueSettings.batchInterval, 180000)
                : Math.max(queueSettings.batchInterval, 90000);
            await updateStatusOverlay("Aguardando proximo lote...", totalProcessed, totalProcessed + promptQueue.length);
            notifyTab({
                action: "BATCH_PAUSE",
                data: { remaining: promptQueue.length, interval: batchDelay }
            });
            delay = batchDelay;
            currentBatchCount = 0;
        }
        chrome.alarms.create("dottiNextPrompt", { when: Date.now() + delay });
    } else if (promptQueue.length === 0 && totalProcessed > 0) {
        isProcessingQueue = false;
        setBadgeStatus("active");
        try { await saveQueueState(); } catch (_sqe) { }
        await sleep(3000);
        await removeStatusOverlay();
        // Maximizar janela SOMENTE se estava minimizada (segundo plano ativo)
        if (veoWindowId && isWindowMini) {
            try {
                await chrome.windows.update(veoWindowId, {
                    state: "maximized",
                    focused: true
                });
                isWindowMini = false;
            } catch (e) { }
        }
        notifyTab({ action: "QUEUE_COMPLETE", data: { total: totalProcessed } });
    }
}

async function startQueue(prompts, settings, tabId, mediaType, bgMode, autoDownload, aiRewrite) {
    // Config do servidor + licenca ativa
    const config = await _ensureConfig();
    if (!config) return { success: false, error: "no_config", message: "Nao foi possivel obter configuracao do servidor. Verifique sua licenca." };
    if (!sdk?.isLicenseActive()) return { success: false, error: "invalid_license", message: "Licenca invalida ou expirada" };

    if (!tabId && targetTabId) tabId = targetTabId;
    if (!tabId) return { success: false, error: "no_tab" };

    // v3.1.0: Se ja esta processando, logar aviso (content.js tratará a re-entrada)
    if (isProcessingQueue) {
        console.log("[Dotti] startQueue: sobrescrevendo fila anterior (isProcessingQueue era true)");
    }

    promptQueue = [...prompts];
    processedPrompts = [];
    queueSettings = {
        promptDelay: (settings.promptDelay || 3) * 1000,
        batchSize: settings.batchSize || 20,
        batchInterval: (settings.batchInterval || 90) * 1000,
        outputCount: settings.outputCount || 1
    };
    currentBatchCount = 0;
    queuePaused = false;
    targetTabId = tabId;
    totalProcessed = 0;
    firstPromptOfBatch = true;
    isProcessingQueue = true;
    lastActivityTime = Date.now();
    queueMediaType = mediaType || "video";
    // Salvar flag de segundo plano para uso no resume/complete
    _backgroundModeActive = bgMode !== false;

    setBadgeStatus("processing");

    // Persist veoTabId
    await chrome.storage.local.set({ veoTabId: targetTabId });
    try { await saveQueueState(); } catch (_sqe) { console.log("[Dotti] saveQueueState falhou (nao-critico):", _sqe.message); }

    // Minimizar janela + overlay SOMENTE se segundo plano ativado
    let winId = null;
    try {
        const tab = await chrome.tabs.get(targetTabId);
        winId = tab.windowId;
        veoWindowId = winId;
    } catch (e) {
        winId = veoWindowId;
    }
    if (winId && _backgroundModeActive) {
        try {
            const wi = await chrome.windows.get(winId);
            if (wi.state === "maximized" || wi.state === "fullscreen") {
                await chrome.windows.update(winId, { state: "normal" });
            }
            const size = WINDOW_SIZES.mini;
            const displays = await chrome.system.display.getInfo();
            const pd = displays[0];
            await chrome.windows.update(winId, {
                width: size.width,
                height: size.height,
                left: pd.workArea.width - size.width - 20,
                top: pd.workArea.height - size.height - 20
            });
            isWindowMini = true;
            await chrome.storage.local.set({ isWindowMini: true, veoWindowId: winId });
        } catch (e) { }
        await injectStatusOverlay();
        await updateStatusOverlay("Iniciando...", 0, promptQueue.length);
    } else if (winId) {
        // Segundo plano desativado: manter janela maximizada
        try {
            await chrome.windows.update(winId, { state: "maximized" });
            isWindowMini = false;
            await chrome.storage.local.set({ isWindowMini: false, veoWindowId: winId });
        } catch (e) { }
    }
    await sleep(2000);

    // v3.0.0: Enviar START_AUTOMATION ao content.js para processamento simultaneo
    const maxSim = settings.maxSimultaneous || 3;
    console.log("[Dotti] startQueue: enviando START_AUTOMATION ao content.js, " + prompts.length + " prompts, " + maxSim + " slots");
    try {
        await chrome.tabs.sendMessage(targetTabId, {
            action: 'START_AUTOMATION',
            prompts: prompts,
            settings: {
                promptDelay: settings.promptDelay || 3,
                batchSize: settings.batchSize || 20,
                batchInterval: settings.batchInterval || 90,
                outputCount: settings.outputCount || 1,
                maxSimultaneous: maxSim
            },
            mediaType: mediaType,
            folder: settings.folder || 'DottiVideos',
            autoDownload: autoDownload !== false,
            aiRewrite: aiRewrite !== false
        });
    } catch (e) {
        console.error("[Dotti] Erro ao enviar START_AUTOMATION:", e);
        return { success: false, error: e.message };
    }

    // v3.0.0: content.js agora controla a execucao — background.js nao deve executar prompts
    _delegatedToContentJs = true;
    promptQueue = []; // content.js tem sua propria copia
    isProcessingQueue = false; // impedir processNextPrompt de rodar
    chrome.alarms.clear("dottiNextPrompt");
    saveStateToSession();
    console.log("[Dotti] startQueue: delegated to content.js — background.js execution disabled");

    return { success: true };
}

async function pauseQueue() {
    queuePaused = true;
    isProcessingQueue = false;
    chrome.alarms.clear("dottiNextPrompt");
    try { await saveQueueState(); } catch (_sqe) { }
    await updateStatusOverlay("Pausado", totalProcessed, totalProcessed + promptQueue.length);
    setBadgeStatus("active");
}

async function resumeQueue(bgMode) {
    const config = await _ensureConfig();
    if (!config) return { success: false, error: "no_config" };

    queuePaused = false;
    isProcessingQueue = true;
    lastActivityTime = Date.now();
    firstPromptOfBatch = true;
    // Atualizar flag se fornecido
    if (bgMode !== undefined) _backgroundModeActive = bgMode !== false;
    try { await saveQueueState(); } catch (_sqe) { }

    // Re-minimizar janela + overlay SOMENTE se segundo plano ativado
    let winId = null;
    try {
        const tab = await chrome.tabs.get(targetTabId);
        winId = tab.windowId;
        veoWindowId = winId;
    } catch (e) {
        winId = veoWindowId;
    }
    if (winId && _backgroundModeActive) {
        try {
            const wi = await chrome.windows.get(winId);
            if (wi.state === "maximized" || wi.state === "fullscreen") {
                await chrome.windows.update(winId, { state: "normal" });
            }
            const size = WINDOW_SIZES.mini;
            const displays = await chrome.system.display.getInfo();
            const pd = displays[0];
            await chrome.windows.update(winId, {
                width: size.width,
                height: size.height,
                left: pd.workArea.width - size.width - 20,
                top: pd.workArea.height - size.height - 20
            });
            isWindowMini = true;
        } catch (e) { }
        await injectStatusOverlay();
        await updateStatusOverlay("Retomando...", totalProcessed, totalProcessed + promptQueue.length);
    }
    await sleep(1000);
    processNextPrompt();
    return { success: true };
}

async function cancelQueue() {
    _delegatedToContentJs = false;
    queuePaused = true;
    isProcessingQueue = false;
    chrome.alarms.clear("dottiNextPrompt");
    await clearQueueState(); // also calls saveStateToSession
    await removeStatusOverlay();
    setBadgeStatus("active");
}

// v3.0.0: Reset completo - limpa fila e tracking
async function fullReset() {
    await cancelQueue();
    _mediaIdToPrompt = {};
    await chrome.storage.local.remove([
        'dottiPromptLog'
    ]);
    console.log("[Dotti] Full reset completo - cache e log limpos");
}

// Log persistente de prompts para reenvio preciso
async function logPromptResult(prompt, mediaType) {
    try {
        const data = await chrome.storage.local.get('dottiPromptLog');
        const log = data.dottiPromptLog || [];
        log.push({
            number: prompt.number,
            text: (prompt.text || "").substring(0, 100),
            elements: prompt.elements || [],
            status: prompt.status,
            error: prompt.error || null,
            mediaType: mediaType,
            timestamp: Date.now()
        });
        if (log.length > 500) log.splice(0, log.length - 500);
        await chrome.storage.local.set({ dottiPromptLog: log });
    } catch (e) {
        console.log("[Dotti] Erro ao salvar log:", e.message);
    }
}

async function updatePromptLog(promptNumber, mediaType, mediaStatus) {
    try {
        const data = await chrome.storage.local.get('dottiPromptLog');
        const log = data.dottiPromptLog || [];
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i].number === promptNumber && log[i].mediaType === mediaType) {
                log[i].mediaStatus = mediaStatus;
                log[i].lastUpdate = Date.now();
                break;
            }
        }
        await chrome.storage.local.set({ dottiPromptLog: log });
    } catch (e) { }
}

// ============================================
// ALARMS - v3.0.0 COM BOOT GATE + WATCHDOG
// ============================================
chrome.alarms.onAlarm.addListener(async (alarm) => {
    await _bootPromise;

    if (alarm.name === "dottiKeepAlive") {
        if (isProcessingQueue && !queuePaused && promptQueue.length > 0) {
            lastActivityTime = Date.now();
        }
    } else if (alarm.name === "dottiNextPrompt") {
        processNextPrompt();
    } else if (alarm.name === "dottiLicenseCheck") {
        if (sdk) {
            const savedKey = await sdk.getSavedLicense();
            if (savedKey) {
                const v = await sdk.validateLicense(savedKey);
                if (!v) { _serverConfig = null; setBadgeStatus("inactive"); }
                else await _fetchServerConfig();
            }
        }
    } else if (alarm.name === "dottiConfigRefresh") {
        await _fetchServerConfig();
    } else if (alarm.name === "dottiWatchdog") {
        // v3.0.0: Nao interferir quando content.js esta no controle
        if (_delegatedToContentJs) return;
        if (isProcessingQueue && !queuePaused && promptQueue.length > 0) {
            const timeSinceLastActivity = Date.now() - lastActivityTime;
            if (timeSinceLastActivity > 3 * 60 * 1000) {
                console.log("[Dotti] Watchdog: Queue stuck for", Math.round(timeSinceLastActivity / 1000), "s. Retrying...");
                firstPromptOfBatch = true;
                lastActivityTime = Date.now();
                processNextPrompt().catch(e => console.error("[Dotti] Watchdog stuck retry error:", e));
            }
        }
        if (!isProcessingQueue && !queuePaused && promptQueue.length > 0 && totalProcessed > 0) {
            console.log("[Dotti] Watchdog: Queue has", promptQueue.length, "pending but not processing. Resuming...");
            isProcessingQueue = true;
            firstPromptOfBatch = true;
            setBadgeStatus("processing");
            lastActivityTime = Date.now();
            processNextPrompt().catch(e => console.error("[Dotti] Watchdog resume error:", e));
        }
    }
});

chrome.alarms.create("dottiKeepAlive", { periodInMinutes: 0.3 });
chrome.alarms.create("dottiLicenseCheck", { periodInMinutes: 60 });
chrome.alarms.create("dottiConfigRefresh", { periodInMinutes: 25 });
chrome.alarms.create("dottiWatchdog", { periodInMinutes: 0.33 });

// ============================================
// MESSAGE HANDLER - v3.0.0
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            await _bootPromise;
            if (!isInitialized) await initSDK();
            switch (message.action) {
                case "GET_STATUS":
                    sendResponse({
                        isInitialized: true,
                        hasLicense: sdk?.isLicenseActive() || false,
                        licenseInfo: sdk?.getLicenseInfo() || null,
                        hasServerConfig: !!_serverConfig,
                        queueLength: promptQueue.length,
                        isProcessing: isProcessingQueue || _delegatedToContentJs,
                        isPaused: queuePaused
                    });
                    break;

                case "GET_FULL_STATE":
                    sendResponse({
                        isProcessing: isProcessingQueue || _delegatedToContentJs,
                        isPaused: queuePaused,
                        promptQueue: promptQueue,
                        processedPrompts: processedPrompts,
                        totalProcessed: totalProcessed,
                        queueSettings: queueSettings,
                        lastActivity: lastActivityTime,
                        mediaType: queueMediaType,
                        mediaIdMapCount: Object.keys(_mediaIdToPrompt).length,
                        hasVeoWindow: !!veoWindowId,
                        isWindowMini: isWindowMini,
                        veoTabId: targetTabId
                    });
                    break;

                case "ACTIVATE_LICENSE":
                    if (!message.licenseKey) { sendResponse({ success: false, error: "missing_key" }); break; }
                    console.log("[Dotti] ACTIVATE_LICENSE key:", message.licenseKey, "deviceId:", sdk?.deviceId);
                    const ar = await sdk.activateLicense(message.licenseKey);
                    console.log("[Dotti] ACTIVATE_LICENSE resultado:", JSON.stringify(ar));
                    if (ar.success) {
                        const lic = ar.license || {};
                        const devUsed = parseInt(lic.devices_used) || 0;
                        const devMax = parseInt(lic.max_devices) || 2;
                        console.log("[Dotti] Dispositivos:", devUsed + "/" + devMax);
                        // v3.2.2: Fix >= (antes era > que deixava passar 4o dispositivo em plano de 3)
                        if (devUsed > devMax) {
                            console.log("[Dotti] BLOQUEADO: limite de dispositivos excedido", devUsed + "/" + devMax);
                            // Desativar este dispositivo que acabou de ser registrado indevidamente
                            try { await sdk.deactivateLicense(); } catch (e) { console.log("[Dotti] Erro ao desativar dispositivo excedente:", e); }
                            sendResponse({ success: false, error: "max_devices", message: "Limite de dispositivos atingido (" + devUsed + "/" + devMax + "). Desative um dispositivo no painel." });
                            break;
                        }
                        await _fetchServerConfig();
                    }
                    sendResponse(ar);
                    break;

                case "DEACTIVATE_LICENSE":
                    const dr = await sdk.deactivateLicense();
                    _serverConfig = null; _sessionToken = null;
                    sendResponse(dr);
                    break;

                case "VERIFY_SESSION_FOR_SENDING":
                    const savedLicense = await sdk.getSavedLicense();
                    if (savedLicense) {
                        const validateResult = await sdk.validateLicense(savedLicense);
                        const isValid = validateResult === true || validateResult?.valid === true;
                        if (isValid) {
                            const li = sdk.getLicenseInfo();
                            const dUsed = parseInt(li?.devicesUsed || li?.devices_used) || 0;
                            const dMax = parseInt(li?.maxDevices || li?.max_devices) || 2;
                            // v3.2.2: Fix >= (consistente com ACTIVATE_LICENSE)
                            if (dUsed > dMax) {
                                console.log("[Dotti] VERIFY blocked: devices", dUsed + "/" + dMax);
                                sendResponse({ valid: false, error: 'max_devices', message: 'Limite de dispositivos excedido' });
                                break;
                            }
                            const vConfig = await _ensureConfig();
                            sendResponse({ valid: true, hasConfig: !!vConfig });
                        } else {
                            sendResponse({ valid: false, error: validateResult?.error || 'validation_failed' });
                        }
                    } else {
                        sendResponse({ valid: false, error: 'no_license' });
                    }
                    break;

                case "START_QUEUE":
                    sendResponse(await startQueue(message.prompts, message.settings, message.tabId || targetTabId, message.mediaType, message.backgroundMode, message.autoDownload, message.aiRewrite));
                    break;

                case "PAUSE_QUEUE":
                    await pauseQueue();
                    sendResponse({ success: true });
                    break;

                case "RESUME_QUEUE":
                    sendResponse(await resumeQueue(message.backgroundMode));
                    break;

                case "CANCEL_QUEUE":
                    await cancelQueue();
                    // Tambem parar automacao no content.js
                    if (targetTabId) {
                        try { await chrome.tabs.sendMessage(targetTabId, { action: 'STOP_AUTOMATION' }); } catch (e) {}
                    }
                    sendResponse({ success: true });
                    break;

                // v3.0.0: POLICY_ERROR_REWRITE — reescrever prompt via API do servidor
                case "POLICY_ERROR_REWRITE":
                    (async () => {
                        try {
                            const config = await _ensureConfig();
                            if (!config) {
                                sendResponse({ success: false, error: 'no_config' });
                                return;
                            }
                            const licenseData = await chrome.storage.local.get('dottiflow_license');
                            const licenseKey = licenseData.dottiflow_license?.key;

                            const response = await fetch(CONFIG.apiUrl + '/ai/rewrite-prompt', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-Product-Slug': CONFIG.productSlug,
                                    'X-License-Key': licenseKey || ''
                                },
                                body: JSON.stringify({
                                    prompt: message.prompt,
                                    provider: 'gemini'
                                })
                            });
                            const data = await response.json();
                            if (data.rewritten) {
                                console.log('[Dotti] Prompt reescrito com sucesso');
                                sendResponse({ success: true, rewrittenPrompt: data.rewritten });
                            } else {
                                sendResponse({ success: false, error: data.error || 'No rewritten prompt' });
                            }
                        } catch (e) {
                            console.error('[Dotti] Erro ao reescrever prompt:', e);
                            sendResponse({ success: false, error: e.message });
                        }
                    })();
                    return true; // async sendResponse

                // v3.0.0: HARD_RESET_STARTED — content.js iniciou hard reset
                // v3.2.5: Cooldown agora é feito in-place pelo content.js (sem navegar)
                // Background.js apenas registra e aguarda
                case "HARD_RESET_STARTED":
                    (async () => {
                        try {
                            const resumeIdx = message.resumeFromIndex;
                            console.log('[Dotti] Hard Reset iniciado (in-place), resumeFromIndex=' + resumeIdx);
                            isProcessingQueue = false;
                            queuePaused = true;
                            saveStateToSession();
                            sendResponse({ success: true });
                        } catch (e) {
                            sendResponse({ success: false, error: e.message });
                        }
                    })();
                    return true;

                // v3.0.0: QUEUE_STATUS_UPDATE — content.js reporta progresso
                case "QUEUE_STATUS_UPDATE":
                    (async () => {
                        try {
                            const { sent, total, generating, completed, failed, generated } = message;
                            totalProcessed = completed || 0;
                            lastActivityTime = Date.now();
                            saveStateToSession();
                            if (_backgroundModeActive) {
                                const geradosCount = generated || ((completed || 0) + (generating || 0));
                                await updateStatusOverlay(
                                    'Enviados: ' + (sent || 0) + '/' + (total || 0) + ' | Gerados: ' + geradosCount,
                                    sent || 0,
                                    total || 0
                                );
                            }
                            if (generating > 0) setBadgeStatus("processing");
                        } catch (e) {}
                        sendResponse({ success: true });
                    })();
                    return true;

                // v3.0.0: QUEUE_COMPLETE do content.js (processamento simultaneo terminou)
                // Este handler complementa o existente — content.js notifica quando processAllPromptsWithSlots() termina
                case "QUEUE_COMPLETE_FROM_CONTENT":
                    (async () => {
                        try {
                            console.log('[Dotti] QUEUE_COMPLETE_FROM_CONTENT recebido, veoWindowId=' + veoWindowId);
                            _delegatedToContentJs = false;
                            isProcessingQueue = false;
                            stopWindowGuard();
                            promptQueue = [];
                            queuePaused = false;
                            try { await saveQueueState(); } catch (_sqe) { } // also calls saveStateToSession
                            setBadgeStatus("active");
                            await removeStatusOverlay();
                            // v3.1.0: Maximizar a janela ao terminar (com retry)
                            const winId = veoWindowId || (await chrome.storage.local.get('veoWindowId')).veoWindowId;
                            if (winId) {
                                for (let attempt = 0; attempt < 3; attempt++) {
                                    try {
                                        await new Promise(r => setTimeout(r, 500));
                                        await chrome.windows.update(winId, { state: "maximized", focused: true });
                                        console.log('[Dotti] Janela maximizada com sucesso (tentativa ' + (attempt + 1) + ')');
                                        isWindowMini = false;
                                        await chrome.storage.local.set({ isWindowMini: false });
                                        break;
                                    } catch (e) {
                                        console.log('[Dotti] Erro ao maximizar (tentativa ' + (attempt + 1) + '):', e.message);
                                    }
                                }
                            } else {
                                console.log('[Dotti] Nao foi possivel maximizar: veoWindowId nulo');
                            }
                        } catch (e) { console.log('[Dotti] Erro em QUEUE_COMPLETE_FROM_CONTENT:', e); }
                        sendResponse({ success: true });
                    })();
                    return true;

                // v3.0.0: POLICY_ERROR relay do content.js para panel
                case "POLICY_ERROR":
                    // Relay para o panel via notifyTab (que envia postMessage ao iframe)
                    notifyTab({ action: "POLICY_ERROR", data: message });
                    sendResponse({ success: true });
                    break;

                case "FULL_RESET":
                    await fullReset();
                    // v3.1.1: Parar automacao no content.js tambem
                    if (targetTabId) {
                        try { await chrome.tabs.sendMessage(targetTabId, { action: 'STOP_AUTOMATION' }); } catch (e) {}
                    }
                    sendResponse({ success: true });
                    break;

                case "INJECT_FETCH_INTERCEPT":
                    (async () => {
                        try {
                            const tabId = sender.tab?.id;
                            if (!tabId) { sendResponse({ success: false }); return; }
                            const count = message.count || 1;
                            await chrome.scripting.executeScript({
                                target: { tabId },
                                world: "MAIN",
                                func: (desiredCount) => {
                                    if (window.__dottiFetchInterceptInstalled) {
                                        window.__dottiOutputCount = desiredCount;
                                        console.log("[Dotti Inject] Output count atualizado para", desiredCount);
                                        return;
                                    }
                                    window.__dottiOutputCount = desiredCount;
                                    window.__dottiFetchInterceptInstalled = true;

                                    window.addEventListener('__dotti_set_output_count', (e) => {
                                        window.__dottiOutputCount = parseInt(e.detail?.count) || 1;
                                        console.log("[Dotti Inject] Output count via event:", window.__dottiOutputCount);
                                    });

                                    const origFetch = window.fetch;
                                    window.fetch = async function (...args) {
                                        let [url, options] = args;
                                        const cnt = window.__dottiOutputCount;
                                        if (cnt > 1 && options?.body && typeof url === 'string' &&
                                            (url.includes('aisandbox-pa.googleapis.com') || url.includes('generativelanguage') || url.includes('labs.google'))) {
                                            try {
                                                const bodyStr = typeof options.body === 'string' ? options.body : null;
                                                if (bodyStr && bodyStr.startsWith('{')) {
                                                    const body = JSON.parse(bodyStr);
                                                    let modified = false;

                                                    function deepModify(obj) {
                                                        if (typeof obj !== 'object' || obj === null) return false;
                                                        let found = false;
                                                        for (const key of Object.keys(obj)) {
                                                            const kl = key.toLowerCase();
                                                            if (kl === 'samplecount' || kl === 'sample_count' ||
                                                                kl === 'candidatecount' || kl === 'candidate_count' ||
                                                                kl === 'numoutputs' || kl === 'num_outputs' ||
                                                                (kl === 'count' && typeof obj[key] === 'number')) {
                                                                obj[key] = cnt;
                                                                found = true;
                                                            }
                                                            if (typeof obj[key] === 'object') {
                                                                if (deepModify(obj[key])) found = true;
                                                            }
                                                        }
                                                        return found;
                                                    }

                                                    modified = deepModify(body);

                                                    if (!modified && body.parameters) {
                                                        body.parameters.sampleCount = cnt;
                                                        modified = true;
                                                    }
                                                    if (!modified) {
                                                        body.sampleCount = cnt;
                                                        modified = true;
                                                    }

                                                    if (modified) {
                                                        options = Object.assign({}, options, { body: JSON.stringify(body) });
                                                        console.log("[Dotti Inject] Request modificado: sampleCount=" + cnt);
                                                    }
                                                }
                                            } catch (e) {
                                                // Body nao eh JSON, ignorar
                                            }
                                        }
                                        return origFetch.apply(this, [url, options]);
                                    };

                                    const origXHRSend = XMLHttpRequest.prototype.send;
                                    XMLHttpRequest.prototype.send = function (body) {
                                        const cnt = window.__dottiOutputCount;
                                        if (cnt > 1 && body && typeof body === 'string' && body.startsWith('{')) {
                                            const url = this._dottiUrl || '';
                                            if (url.includes('aisandbox-pa.googleapis.com') || url.includes('generativelanguage') || url.includes('labs.google')) {
                                                try {
                                                    const parsed = JSON.parse(body);
                                                    let modified = false;
                                                    function deepModify(obj) {
                                                        if (typeof obj !== 'object' || obj === null) return false;
                                                        let found = false;
                                                        for (const key of Object.keys(obj)) {
                                                            const kl = key.toLowerCase();
                                                            if (kl === 'samplecount' || kl === 'sample_count' ||
                                                                kl === 'candidatecount' || kl === 'candidate_count' ||
                                                                (kl === 'count' && typeof obj[key] === 'number')) {
                                                                obj[key] = cnt;
                                                                found = true;
                                                            }
                                                            if (typeof obj[key] === 'object') {
                                                                if (deepModify(obj[key])) found = true;
                                                            }
                                                        }
                                                        return found;
                                                    }
                                                    modified = deepModify(parsed);
                                                    if (!modified) { parsed.sampleCount = cnt; }
                                                    body = JSON.stringify(parsed);
                                                    console.log("[Dotti Inject XHR] Request modificado: sampleCount=" + cnt);
                                                } catch (e) { }
                                            }
                                        }
                                        return origXHRSend.call(this, body);
                                    };

                                    const origXHROpen = XMLHttpRequest.prototype.open;
                                    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                                        this._dottiUrl = url;
                                        return origXHROpen.call(this, method, url, ...rest);
                                    };

                                    console.log("[Dotti Inject] Fetch/XHR intercept instalado, count=" + desiredCount);
                                },
                                args: [count]
                            });
                            sendResponse({ success: true });
                        } catch (e) {
                            console.log("[Dotti] Inject fetch intercept error:", e.message);
                            sendResponse({ success: false, error: e.message });
                        }
                    })();
                    return true;

                case "GET_PROMPT_LOG":
                    chrome.storage.local.get('dottiPromptLog', (data) => {
                        sendResponse({ log: data.dottiPromptLog || [] });
                    });
                    return true;

                case "UPDATE_PROMPT_LOG":
                    updatePromptLog(message.promptNumber, message.mediaType, message.mediaStatus);
                    sendResponse({ success: true });
                    break;

                case "GET_QUEUE_STATUS":
                    sendResponse({
                        queueLength: promptQueue.length,
                        isProcessing: isProcessingQueue,
                        isPaused: queuePaused,
                        currentBatch: currentBatchCount,
                        settings: queueSettings,
                        totalProcessed: totalProcessed
                    });
                    break;

                case "VIDEO_SUBMITTED": {
                    const { media } = message;
                    if (media && Array.isArray(media)) {
                        for (const entry of media) {
                            if (entry.mediaId) {
                                _mediaIdToPrompt[entry.mediaId] = {
                                    prompt: entry.prompt || "",
                                    timestamp: Date.now()
                                };
                            }
                        }
                    }
                    sendResponse({ success: true });
                    break;
                }

                case "VIDEO_STATUS_UPDATE": {
                    const { updates } = message;
                    // Just acknowledge - panel.js handles the actual state updates
                    sendResponse({ success: true });
                    break;
                }

                case "DOWNLOAD_VIDEO": {
                    const { url, filename, folder } = message;
                    if (!url) { sendResponse({ success: false, error: "no_url" }); break; }
                    const fullPath = folder ? folder + "/" + filename : filename;
                    try {
                        const downloadId = await chrome.downloads.download({
                            url: url,
                            filename: fullPath,
                            conflictAction: "uniquify",
                            saveAs: false
                        });
                        console.log("[Dotti] Download video started:", downloadId, fullPath);
                        sendResponse({ success: true, downloadId });
                    } catch (e) {
                        console.error("[Dotti] Download video error:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                    break;
                }

                case "DOWNLOAD_IMAGE": {
                    const { url, filename, folder } = message;
                    if (!url) { sendResponse({ success: false, error: "no_url" }); break; }
                    const fullPath = folder ? folder + "/" + filename : filename;
                    try {
                        const downloadId = await chrome.downloads.download({
                            url: url,
                            filename: fullPath,
                            conflictAction: "uniquify",
                            saveAs: false
                        });
                        console.log("[Dotti] Download image started:", downloadId, fullPath);
                        sendResponse({ success: true, downloadId });
                    } catch (e) {
                        console.error("[Dotti] Download image error:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                    break;
                }

                case "ENSURE_WINDOW_ACTIVE":
                    sendResponse({ success: true });
                    break;

                case "GET_SETTINGS":
                    chrome.storage.local.get([
                        "autoDownload", "aiRewrite", "backgroundMode", "batchSize", "batchInterval", "promptDelay",
                        "videoFolder", "imageFolder", "frameFolder", "videoResolution", "imageResolution",
                        "videoOutputCount", "imageOutputCount"
                    ], (s) => {
                        sendResponse({
                            autoDownload: s.autoDownload !== false,
                            aiRewrite: s.aiRewrite !== false,
                            backgroundMode: s.backgroundMode !== false,
                            batchSize: s.batchSize || 20,
                            batchInterval: s.batchInterval || 90,
                            promptDelay: s.promptDelay || 3,
                            videoFolder: s.videoFolder || "DottiVideos",
                            imageFolder: s.imageFolder || "DottiImagens",
                            frameFolder: s.frameFolder || "DottiFrameVideos",
                            videoResolution: s.videoResolution || "720",
                            imageResolution: s.imageResolution || "1024",
                            videoOutputCount: s.videoOutputCount || 1,
                            imageOutputCount: s.imageOutputCount || 1
                        });
                    });
                    return true;

                case "SAVE_SETTINGS":
                    chrome.storage.local.set(message.settings, () => sendResponse({ success: true }));
                    return true;

                case "GET_ACTIVE_TAB":
                    if (targetTabId) {
                        sendResponse({ tabId: targetTabId, url: "https://labs.google/fx/tools/flow" });
                    } else {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        sendResponse({ tabId: tab?.id, url: tab?.url });
                    }
                    break;

                case "KEEP_ALIVE":
                    sendResponse({ alive: true });
                    break;

                case "GET_AUTO_NEW_PROJECT":
                    const autoData = await chrome.storage.local.get("dottiAutoNewProject");
                    if (autoData.dottiAutoNewProject) {
                        await chrome.storage.local.remove("dottiAutoNewProject");
                        sendResponse({ autoNewProject: true });
                    } else {
                        sendResponse({ autoNewProject: false });
                    }
                    break;

                case "CHECK_FEATURE":
                    if (!sdk || !_serverConfig) {
                        sendResponse({ allowed: false, error: "no_config" });
                    } else {
                        const feature = message.feature;
                        const features = _serverConfig.features || {};
                        sendResponse({ allowed: !!features[feature] });
                    }
                    break;

                case "GET_FEATURE_LIMIT":
                    if (!sdk || !_serverConfig) {
                        sendResponse({ limit: 0, error: "no_config" });
                    } else {
                        const feat = message.feature;
                        const limits = _serverConfig.limits || {};
                        sendResponse({ limit: limits[feat] || 0 });
                    }
                    break;

                case "GET_SESSION_STATUS":
                    if (!sdk) {
                        sendResponse({ active: false, error: "sdk_not_ready" });
                    } else {
                        const info = sdk.getLicenseInfo();
                        sendResponse({
                            active: sdk.isLicenseActive(),
                            info: info,
                            hasConfig: !!_serverConfig,
                            sessionToken: _sessionToken ? true : false
                        });
                    }
                    break;

                case "OPEN_VEO_WINDOW":
                    const win = await openVeoWindow(message.mini !== false);
                    sendResponse({ success: true, windowId: win.id, tabId: targetTabId });
                    break;

                case "TOGGLE_WINDOW_SIZE":
                    sendResponse(await toggleWindowSize());
                    break;

                case "FOCUS_VEO_WINDOW":
                    await focusVeoWindow();
                    sendResponse({ success: true });
                    break;

                case "MINIMIZE_WINDOW":
                    try {
                        const fw = await chrome.windows.getLastFocused();
                        if (fw.state === "maximized" || fw.state === "fullscreen") {
                            await chrome.windows.update(fw.id, { state: "normal" });
                        }
                        const size = WINDOW_SIZES.mini;
                        const displays = await chrome.system.display.getInfo();
                        const pd = displays[0];
                        await chrome.windows.update(fw.id, {
                            width: size.width,
                            height: size.height,
                            left: pd.workArea.width - size.width - 20,
                            top: pd.workArea.height - size.height - 20
                        });
                        isWindowMini = true;
                        veoWindowId = fw.id;
                        sendResponse({ success: true });
                    } catch (e) {
                        sendResponse({ success: false, error: e.message });
                    }
                    break;

                case "GET_SELECTORS":
                    if (!_serverConfig || !_serverConfig.selectors) {
                        sendResponse({ success: false, error: "no_config" });
                    } else {
                        sendResponse({ success: true, selectors: _serverConfig.selectors });
                    }
                    break;

                default:
                    sendResponse({ error: "Unknown action" });
            }
        } catch (e) {
            sendResponse({ error: e.message });
        }
    })();
    return true;
});

// ============================================
// ACTION & STARTUP
// ============================================
chrome.action.onClicked.addListener(async () => {
    await _bootPromise;

    if (veoWindowId) {
        await focusVeoWindow();
        if (targetTabId) {
            try {
                await chrome.tabs.sendMessage(targetTabId, { action: "TOGGLE_PANEL" });
            } catch (e) { }
        }
    } else {
        await openVeoWindow(false);
    }
});

chrome.runtime.onInstalled.addListener(async () => {
    await _bootPromise;

    const licData = await chrome.storage.local.get('dottiflow_license');
    const savedKey = licData.dottiflow_license?.key;
    if (savedKey && (savedKey.includes("TESTE") || savedKey === "test-device")) {
        console.log("[Dotti] Removing invalid test license data");
        await chrome.storage.local.remove(['dottiflow_license', 'dottiflow_session', 'dottiflow_last_heartbeat']);
    }

    try {
        await chrome.contentSettings.automaticDownloads.set({
            primaryPattern: 'https://labs.google/*',
            setting: 'allow'
        });
        console.log("[Dotti] Downloads automaticos permitidos para labs.google");
    } catch (e) {
        console.log("[Dotti] Nao foi possivel configurar downloads automaticos:", e.message);
    }
});

chrome.runtime.onStartup.addListener(async () => {
    await _bootPromise;
    if (!queuePaused && promptQueue.length > 0) {
        const cfg = await _ensureConfig();
        if (cfg) {
            isProcessingQueue = true;
            setBadgeStatus("processing");
            setTimeout(processNextPrompt, 3000);
        }
    }
});

// ============================================
// BOOT PROMISE - v3.0.0
// ============================================
const _bootPromise = (async () => {
    // Garantir device_id unico antes do SDK
    const stored = await chrome.storage.local.get('dottiflow_device_id');
    if (!stored.dottiflow_device_id) {
        const uniqueId = 'ext_' + crypto.randomUUID().replace(/-/g, '').substring(0, 12);
        await chrome.storage.local.set({ dottiflow_device_id: uniqueId });
        console.log("[Dotti] Device ID gerado:", uniqueId);
    }
    await initSDK();
    await loadQueueState();
    console.log("[Dotti] Boot complete. Queue:", promptQueue.length, "Processing:", isProcessingQueue);
})();
