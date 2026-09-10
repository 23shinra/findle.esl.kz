const inputTextEl = document.getElementById("inputText");
const resultsEl = document.getElementById("results");
const clearBtn = document.getElementById("clearBtn");
const pasteBtn = document.getElementById("pasteBtn");
const installBtn = document.getElementById("installBtn");

document.querySelectorAll(".brand-tag").forEach((el) => el.remove());

let deferredInstallPrompt = null;

if (installBtn && window.matchMedia("(display-mode: standalone)").matches) {
  installBtn.hidden = true;
}

// --- Local SQLite (sql.js) persisted in IndexedDB ---
const DB_IDB_NAME = "links-local-sqlite";
const DB_IDB_STORE = "kv";
const DB_IDB_KEY = "db";
let _dbPromise = null;
let _saveTimer = null;

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_IDB_STORE)) db.createObjectStore(DB_IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_IDB_STORE, "readonly");
    const store = tx.objectStore(DB_IDB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_IDB_STORE, "readwrite");
    const store = tx.objectStore(DB_IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function initSqlite() {
  if (typeof initSqlJs !== "function") return null;
  const SQL = await initSqlJs({
    locateFile: (f) =>
      `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`,
  });

  const saved = await idbGet(DB_IDB_KEY);
  const db = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  return db;
}

function getDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = initSqlite().catch(() => null);
  return _dbPromise;
}

async function persistDb(db) {
  try {
    const data = db.export();
    await idbSet(DB_IDB_KEY, data);
  } catch {
    // ignore: persistence is best-effort
  }
}

async function recordInputText(text) {
  const t = String(text ?? "").trim();
  if (!t) return;

  // Best-effort send to backend when hosted (ignored if offline/file://)
  try {
    if (location.protocol !== "file:") {
      fetch("/api/inputs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // ignore
  }

  const db = await getDb();
  if (!db) return;

  try {
    // Avoid spamming identical consecutive rows
    const res = db.exec("SELECT text FROM inputs ORDER BY id DESC LIMIT 1;");
    const last = res?.[0]?.values?.[0]?.[0] ?? null;
    if (last === t) return;

    const stmt = db.prepare("INSERT INTO inputs(text, created_at) VALUES (?, ?);");
    stmt.run([t, Date.now()]);
    stmt.free();

    // Persist with debounce (writes to IndexedDB can be expensive)
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => persistDb(db), 800);
  } catch {
    // ignore
  }
}

function uniq(arr) {
  return [...new Set(arr)];
}

/** Приводит к единому виду: 77471234567 (без 8, +7 и прочего) */
function toUnifiedPhoneDigits(rawDigits) {
  let d = String(rawDigits).replace(/[^\d]/g, "");
  if (!d || d.length < 7 || d.length > 15) return null;

  if (d.length === 11 && d.startsWith("8")) {
    d = "7" + d.slice(1);
  } else if (d.length === 10 && d.startsWith("7")) {
    d = "7" + d;
  }

  return d;
}

function normalizePhoneCandidate(raw) {
  const digits = toUnifiedPhoneDigits(raw.trim());
  if (!digits) return null;
  return { digits, display: digits };
}

function extractPhones(text) {
  const candidates = [];

  const plusNumber = text.match(/\+\s*[\d][\d\s().-]{5,}/g);
  if (plusNumber) candidates.push(...plusNumber);

  const longDigits = text.match(/\b\d[\d\s().-]{6,}\d\b/g);
  if (longDigits) candidates.push(...longDigits);

  const normalized = candidates.map(normalizePhoneCandidate).filter(Boolean);

  const byDigits = new Map();
  for (const p of normalized) {
    if (!byDigits.has(p.digits)) byDigits.set(p.digits, p);
  }

  return [...byDigits.values()];
}

function cleanIgUsername(u) {
  const username = u
    .trim()
    .replace(/^@+/, "")
    .replace(/^[^a-zA-Z0-9._]+/, "")
    .replace(/[^a-zA-Z0-9._]+$/g, "");

  if (!username) return null;
  if (username.length < 1 || username.length > 30) return null;
  if (username.startsWith(".") || username.endsWith(".")) return null;
  if (username.includes("..")) return null;
  if (!/^[a-zA-Z0-9._]+$/.test(username)) return null;
  return username;
}

function extractInstagram(text) {
  const usernames = [];

  const handleMatches = text.match(/(?:^|[\s(])@([a-zA-Z0-9._]{1,30})(?![a-zA-Z0-9._])/g);
  if (handleMatches) {
    for (const m of handleMatches) {
      const u = cleanIgUsername(m.replace(/.*@/, ""));
      if (u) usernames.push(u);
    }
  }

  const urlMatches = text.match(
    /\bhttps?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9._]{1,30})(?:\/|\b)/gi,
  );
  if (urlMatches) {
    for (const u of urlMatches) {
      const m = u.match(/instagram\.com\/([a-zA-Z0-9._]{1,30})/i);
      const username = cleanIgUsername(m?.[1] ?? "");
      if (username) usernames.push(username);
    }
  }

  const nakedMatches = text.match(/\binstagram\.com\/([a-zA-Z0-9._]{1,30})(?:\/|\b)/gi);
  if (nakedMatches) {
    for (const u of nakedMatches) {
      const m = u.match(/instagram\.com\/([a-zA-Z0-9._]{1,30})/i);
      const username = cleanIgUsername(m?.[1] ?? "");
      if (username) usernames.push(username);
    }
  }

  const igMeMatches = text.match(/\bhttps?:\/\/ig\.me\/m\/([a-zA-Z0-9._]{1,30})(?:\b|\/)/gi);
  if (igMeMatches) {
    for (const u of igMeMatches) {
      const m = u.match(/ig\.me\/m\/([a-zA-Z0-9._]{1,30})/i);
      const username = cleanIgUsername(m?.[1] ?? "");
      if (username) usernames.push(username);
    }
  }

  return uniq(usernames);
}

function cleanTgUsername(u) {
  const username = u
    .trim()
    .replace(/^@+/, "")
    .replace(/^[^a-zA-Z0-9_]+/, "")
    .replace(/[^a-zA-Z0-9_]+$/g, "");

  if (!username) return null;
  if (username.length < 5 || username.length > 32) return null;
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return null;
  return username;
}

function extractTelegram(text) {
  const usernames = [];

  const handleMatches = text.match(/(?:^|[\s(])@([a-zA-Z0-9_]{5,32})(?![a-zA-Z0-9_])/g);
  if (handleMatches) {
    for (const m of handleMatches) {
      const u = cleanTgUsername(m.replace(/.*@/, ""));
      if (u) usernames.push(u);
    }
  }

  const urlMatches = text.match(/\bhttps?:\/\/(?:www\.)?t\.me\/([a-zA-Z0-9_]{5,32})(?:\/|\b)/gi);
  if (urlMatches) {
    for (const u of urlMatches) {
      const m = u.match(/t\.me\/([a-zA-Z0-9_]{5,32})/i);
      const username = cleanTgUsername(m?.[1] ?? "");
      if (username) usernames.push(username);
    }
  }

  const nakedMatches = text.match(/\bt\.me\/([a-zA-Z0-9_]{5,32})(?:\/|\b)/gi);
  if (nakedMatches) {
    for (const u of nakedMatches) {
      const m = u.match(/t\.me\/([a-zA-Z0-9_]{5,32})/i);
      const username = cleanTgUsername(m?.[1] ?? "");
      if (username) usernames.push(username);
    }
  }

  return uniq(usernames);
}

function cleanTrailingPunctuation(s) {
  return s.replace(/[),.;:!?]+$/g, "");
}

function extractEmails(text) {
  const emails = [];

  const matches = text.match(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  );
  if (!matches) return [];

  for (const m of matches) {
    const e = cleanTrailingPunctuation(m.trim()).toLowerCase();
    if (!e) continue;
    // very basic sanity: no spaces, exactly one "@"
    if (/\s/.test(e)) continue;
    if ((e.match(/@/g) || []).length !== 1) continue;
    emails.push(e);
  }

  return uniq(emails);
}

function normalizeUrlCandidate(raw) {
  let s = cleanTrailingPunctuation(raw.trim());
  if (!s) return null;

  // Strip surrounding brackets/quotes
  s = s.replace(/^[("'«]+/, "").replace(/[)"'»]+$/, "");
  s = cleanTrailingPunctuation(s);
  if (!s) return null;

  if (/^www\./i.test(s)) {
    s = `https://${s}`;
  } else if (!/^https?:\/\//i.test(s)) {
    // bare domain
    s = `https://${s}`;
  }

  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function extractUrls(text) {
  const found = [];

  const httpMatches = text.match(/\bhttps?:\/\/[^\s<>"']+/gi);
  if (httpMatches) found.push(...httpMatches);

  const wwwMatches = text.match(/\bwww\.[^\s<>"']+/gi);
  if (wwwMatches) found.push(...wwwMatches);

  // domain.tld[/path]
  const domainRe = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;
  for (const m of text.matchAll(domainRe)) {
    const candidate = m[0];
    const idx = m.index ?? -1;
    if (idx > 0 && text[idx - 1] === "@") continue; // skip email domains: name@domain.tld
    found.push(candidate);
  }

  const normalized = found.map(normalizeUrlCandidate).filter(Boolean);
  return uniq(normalized);
}

function waLinkForDigits(digits) {
  const base = `https://wa.me/${encodeURIComponent(digits)}`;
  return base;
}

function telHrefFromPhone(p) {
  const d = p.digits;
  const num = d.startsWith("7") && d.length === 11 ? `+${d}` : d;
  return `tel:${num}`;
}

function igDirectLink(username) {
  return `https://ig.me/m/${encodeURIComponent(username)}`;
}

function igProfileLink(username) {
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

function tgLink(username) {
  return `https://t.me/${encodeURIComponent(username)}`;
}

function tgPhoneLink(digits) {
  return `tg://resolve?phone=${encodeURIComponent(digits)}`;
}

function tgPhoneHttpLink(digits) {
  // Telegram supports links like https://t.me/+79991234567
  return `https://t.me/+${encodeURIComponent(digits)}`;
}

function openTelegramByPhone(digits, display) {
  // Try app deep-link first; if blocked, fall back to https://t.me/+<phone> and copy number.
  let cancelled = false;

  const cancel = () => {
    cancelled = true;
  };

  // If Telegram app opens, tab often becomes hidden/blurred.
  const onVis = () => {
    if (document.hidden) cancel();
  };
  window.addEventListener("blur", cancel, { once: true });
  document.addEventListener("visibilitychange", onVis, { once: true });

  window.location.href = tgPhoneLink(digits);

  setTimeout(async () => {
    if (cancelled) return;
    window.open(tgPhoneHttpLink(digits), "_blank", "noreferrer");
    await copyToClipboard(display);
  }, 650);
}

async function copyToClipboard(text) {
  const t = String(text ?? "");
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

function createBtn({ label, kind = "secondary", onClick, href, openInNewTab = true }) {
  if (href) {
    const a = document.createElement("a");
    a.className = `btn btn-small ${kind === "primary" ? "btn-primary" : "btn-secondary"} action-link`;
    a.href = href;
    const sameDocument = !openInNewTab || /^mailto:|^tel:/i.test(href);
    if (!sameDocument) {
      a.target = "_blank";
      a.rel = "noreferrer";
    }
    a.textContent = label;
    return a;
  }

  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn btn-small ${kind === "primary" ? "btn-primary" : "btn-secondary"}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderGroup(title, items, renderItem) {
  if (!items || items.length === 0) return null;

  const group = document.createElement("section");
  group.className = "result-group";

  const head = document.createElement("div");
  head.className = "result-group-title";
  head.innerHTML = `<div class="name">${title}</div><div class="count">${items.length}</div>`;
  group.appendChild(head);

  const list = document.createElement("div");
  list.className = "result-list";
  for (const it of items) list.appendChild(renderItem(it));
  group.appendChild(list);

  return group;
}

function renderResults({ phones, igUsers, tgUsers, emails, urls }) {
  resultsEl.innerHTML = "";

  const groups = [];

  groups.push(
    renderGroup("Телефон", phones, (p) => {
      const row = document.createElement("div");
      row.className = "result-item";

      const value = document.createElement("div");
      value.className = "result-value";
      value.textContent = p.display;

      const actions = document.createElement("div");
      actions.className = "result-actions";
      actions.appendChild(
        createBtn({
          label: "Позвонить",
          kind: "primary",
          href: telHrefFromPhone(p),
          openInNewTab: false,
        }),
      );
      actions.appendChild(
        createBtn({
          label: "WhatsApp",
          kind: "primary",
          href: waLinkForDigits(p.digits),
        }),
      );
      actions.appendChild(
        createBtn({
          label: "Telegram",
          onClick: () => openTelegramByPhone(p.digits, p.display),
        }),
      );

      row.appendChild(value);
      row.appendChild(actions);
      return row;
    }),
  );

  groups.push(
    renderGroup("Instagram", igUsers, (u) => {
      const row = document.createElement("div");
      row.className = "result-item";

      const value = document.createElement("div");
      value.className = "result-value";
      value.textContent = `@${u}`;

      const actions = document.createElement("div");
      actions.className = "result-actions";
      actions.appendChild(
        createBtn({ label: "Direct", kind: "primary", href: igDirectLink(u) }),
      );
      actions.appendChild(
        createBtn({ label: "Профиль", href: igProfileLink(u) }),
      );
      actions.appendChild(
        createBtn({ label: "Копировать", onClick: () => copyToClipboard(`@${u}`) }),
      );

      row.appendChild(value);
      row.appendChild(actions);
      return row;
    }),
  );

  groups.push(
    renderGroup("Telegram", tgUsers, (u) => {
      const row = document.createElement("div");
      row.className = "result-item";

      const value = document.createElement("div");
      value.className = "result-value";
      value.textContent = `@${u}`;

      const actions = document.createElement("div");
      actions.className = "result-actions";
      actions.appendChild(
        createBtn({
          label: "Открыть чат",
          kind: "primary",
          href: tgLink(u),
        }),
      );
      actions.appendChild(
        createBtn({ label: "Копировать", onClick: () => copyToClipboard(`@${u}`) }),
      );

      row.appendChild(value);
      row.appendChild(actions);
      return row;
    }),
  );

  groups.push(
    renderGroup("Email", emails, (e) => {
      const row = document.createElement("div");
      row.className = "result-item";

      const value = document.createElement("div");
      value.className = "result-value";
      value.textContent = e;

      const actions = document.createElement("div");
      actions.className = "result-actions";
      actions.appendChild(
        createBtn({ label: "Написать", kind: "primary", href: `mailto:${encodeURIComponent(e)}` }),
      );
      actions.appendChild(
        createBtn({ label: "Копировать", onClick: () => copyToClipboard(e) }),
      );

      row.appendChild(value);
      row.appendChild(actions);
      return row;
    }),
  );

  groups.push(
    renderGroup("Ссылки", urls, (u) => {
      const row = document.createElement("div");
      row.className = "result-item";

      const value = document.createElement("div");
      value.className = "result-value";
      value.textContent = u;

      const actions = document.createElement("div");
      actions.className = "result-actions";
      actions.appendChild(createBtn({ label: "Открыть", kind: "primary", href: u }));
      actions.appendChild(createBtn({ label: "Копировать", onClick: () => copyToClipboard(u) }));

      row.appendChild(value);
      row.appendChild(actions);
      return row;
    }),
  );

  for (const g of groups) {
    if (g) resultsEl.appendChild(g);
  }

  if (resultsEl.childElementCount === 0) {
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = "Ничего не найдено.";
    resultsEl.appendChild(badge);
  }
}

function parseAndRender() {
  const text = inputTextEl.value || "";
  recordInputText(text);
  const phones = extractPhones(text);
  const igUsers = extractInstagram(text);
  const tgUsers = extractTelegram(text);
  const emails = extractEmails(text);
  const urls = extractUrls(text);
  renderResults({ phones, igUsers, tgUsers, emails, urls });
}

inputTextEl.addEventListener("input", parseAndRender);
inputTextEl.addEventListener("paste", () => {
  setTimeout(parseAndRender, 0);
});

clearBtn.addEventListener("click", () => {
  inputTextEl.value = "";
  inputTextEl.focus();
  parseAndRender();
});

pasteBtn.addEventListener("click", async () => {
  try {
    const txt = await navigator.clipboard.readText();
    if (typeof txt === "string") {
      inputTextEl.value = txt;
      inputTextEl.focus();
      parseAndRender();
    }
  } catch (e) {
    alert(
      "Не удалось прочитать буфер обмена. Нужен HTTPS, разрешение браузера или вставь текст вручную (Ctrl+V).",
    );
  }
});

function textareaIsEmpty() {
  return !(inputTextEl.value || "").trim();
}

/** При открытии / возврате на вкладку подставляем буфер, если поле пустое. */
async function tryPasteFromClipboardOnOpen() {
  if (!textareaIsEmpty()) return;
  if (!navigator.clipboard?.readText) return;
  try {
    const txt = await navigator.clipboard.readText();
    if (typeof txt !== "string" || !txt.trim()) return;
    if (!textareaIsEmpty()) return;
    inputTextEl.value = txt;
    parseAndRender();
  } catch {
    /* жест пользователя — сработает после первого касания / клавиши */
  }
}

window.addEventListener("load", () => {
  void tryPasteFromClipboardOnOpen();
});

window.addEventListener("pageshow", () => {
  void tryPasteFromClipboardOnOpen();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void tryPasteFromClipboardOnOpen();
});

function bindOneShotClipboardOnInteraction() {
  const handler = () => {
    void tryPasteFromClipboardOnOpen();
  };
  document.addEventListener("pointerdown", handler, { once: true, passive: true });
  document.addEventListener("keydown", handler, { once: true, passive: true });
}

bindOneShotClipboardOnInteraction();

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (installBtn) installBtn.hidden = false;
});

if (installBtn) {
  installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });
}

window.matchMedia("(display-mode: standalone)").addEventListener("change", () => {
  if (window.matchMedia("(display-mode: standalone)").matches && installBtn) {
    installBtn.hidden = true;
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  });
}

parseAndRender();

