const path = require("path");
const fs = require("fs");
const express = require("express");
const rateLimit = require("express-rate-limit");
const sqlite3 = require("sqlite3").verbose();

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "findle.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_SECRET = (process.env.FINDLE_ADMIN_SECRET || "").trim();
const ADMIN_BASIC_USER = process.env.FINDLE_ADMIN_USER || "admin@findle.esl.kz";
const ADMIN_BASIC_PASSWORD = process.env.FINDLE_ADMIN_PASSWORD || "admin";
const ADMIN_PAGE_LIMIT = Math.min(1000, Math.max(1, Number(process.env.FINDLE_ADMIN_LIMIT || 500)));

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_inputs_created_at ON inputs(created_at);`);
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(express.json({ limit: "256kb" }));

const postInputsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: "rate_limit" });
  },
});

const adminGateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).type("text/plain").send("Too many requests");
  },
});

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function requireAdminBasic(req, res, next) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Findle Admin"');
    return res.status(401).type("text/plain").send("Требуется вход");
  }
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    res.set("WWW-Authenticate", 'Basic realm="Findle Admin"');
    return res.status(401).type("text/plain").send("Неверные данные");
  }
  const colon = decoded.indexOf(":");
  const user = colon >= 0 ? decoded.slice(0, colon) : decoded;
  const pass = colon >= 0 ? decoded.slice(colon + 1) : "";
  if (user === ADMIN_BASIC_USER && pass === ADMIN_BASIC_PASSWORD) {
    return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Findle Admin"');
  return res.status(401).type("text/plain").send("Неверный логин или пароль");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/admin", adminGateLimiter, requireAdminBasic, (_req, res) => {
  db.all(
    "SELECT id, text, ip, user_agent, created_at FROM inputs ORDER BY id DESC LIMIT ?;",
    [ADMIN_PAGE_LIMIT],
    (err, rows) => {
      if (err) {
        return res.status(500).type("text/plain").send("Ошибка базы данных");
      }
      const tableRows = (rows || [])
        .map((r) => {
          const when = new Date(Number(r.created_at)).toISOString();
          return `<tr>
  <td>${r.id}</td>
  <td class="mono">${escapeHtml(when)}</td>
  <td class="mono">${escapeHtml(r.ip || "—")}</td>
  <td class="ua">${escapeHtml(r.user_agent || "—")}</td>
  <td class="txt"><pre>${escapeHtml(r.text)}</pre></td>
</tr>`;
        })
        .join("\n");

      res
        .type("html")
        .set("Cache-Control", "no-store")
        .send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="robots" content="noindex,nofollow"/>
  <title>Findle — админка</title>
  <style>
    :root { --bg:#0b1220; --card:#121a2b; --text:#e9eefc; --muted:#a8b3d6; --border:rgba(255,255,255,.1); }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 20px 16px 40px; }
    h1 { font-size: 1.25rem; margin: 0 0 6px; }
    .meta { color: var(--muted); font-size: .85rem; margin-bottom: 16px; }
    .wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--card); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 700; white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: ui-monospace, monospace; font-size: 12px; }
    .ua { max-width: 220px; word-break: break-word; color: var(--muted); font-size: 12px; }
    .txt pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-width: 560px; }
    .empty { padding: 24px; color: var(--muted); text-align: center; }
  </style>
</head>
<body>
  <h1>Findle — сохранённые вводы</h1>
  <p class="meta">До ${ADMIN_PAGE_LIMIT} последних записей из SQLite (<code>inputs</code>). Выход: закройте вкладку или смените сохранённый пароль в браузере.</p>
  <div class="wrap">
    <table>
      <thead><tr><th>id</th><th>время (UTC)</th><th>IP</th><th>User-Agent</th><th>текст</th></tr></thead>
      <tbody>
${tableRows || `<tr><td colspan="5" class="empty">Записей пока нет</td></tr>`}
      </tbody>
    </table>
  </div>
</body>
</html>`);
    },
  );
});

app.post("/api/inputs", postInputsLimiter, (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "text_required" });
  if (text.length > 20000) return res.status(413).json({ ok: false, error: "text_too_large" });

  const forwarded = req.headers["x-forwarded-for"];
  const ip =
    (typeof forwarded === "string" ? forwarded.split(",")[0] : forwarded?.[0])?.trim() ||
    req.socket.remoteAddress ||
    null;
  const ua = req.headers["user-agent"]?.toString() || null;
  const createdAt = Date.now();

  db.get("SELECT text FROM inputs ORDER BY id DESC LIMIT 1;", (err, row) => {
    if (!err && row?.text === text) return res.json({ ok: true, deduped: true });

    db.run(
      "INSERT INTO inputs(text, ip, user_agent, created_at) VALUES (?, ?, ?, ?);",
      [text, ip, ua, createdAt],
      function (e) {
        if (e) return res.status(500).json({ ok: false, error: "db_error" });
        res.json({ ok: true, id: this.lastID });
      },
    );
  });
});

app.get("/api/inputs", (req, res) => {
  if (!ADMIN_SECRET || ADMIN_SECRET.length < 8) {
    return res.status(403).json({ ok: false, error: "list_disabled" });
  }

  const bearer = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const headerSecret = String(req.get("x-findle-admin") || "").trim();
  if (bearer !== ADMIN_SECRET && headerSecret !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  db.all(
    "SELECT id, text, ip, user_agent, created_at FROM inputs ORDER BY id DESC LIMIT ?;",
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: "db_error" });
      res.json({ ok: true, rows });
    },
  );
});

function sendPublicNoCache(file, contentType) {
  return (_req, res) => {
    if (contentType) res.type(contentType);
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}

app.get("/sw.js", sendPublicNoCache("sw.js", "application/javascript"));
app.get("/manifest.webmanifest", sendPublicNoCache("manifest.webmanifest", "application/manifest+json"));

app.use(
  express.static(PUBLIC_DIR, {
    dotfiles: "deny",
    index: "index.html",
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  }),
);

app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }
  res.status(404).type("text/plain").send("Not found");
});

app.listen(PORT, HOST, () => {
  console.log(`Findle server listening on http://${HOST}:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Public: ${PUBLIC_DIR}`);
});
