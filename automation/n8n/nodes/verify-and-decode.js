/* n8n Code-нода «Verify & Decode» (workflow radflow-price-import).
   ⚠️ РЕДАКТОВАНО ДЛЯ РЕПО: SECRET замінено на REPLACE_ME_IMPORT_SECRET.
   У живому workflow тут стоїть IMPORT_WEBHOOK_SECRET (з Vercel env). Секрет
   живе КОНСТАНТОЮ у ДВОХ нодах — тут і в «Sign Response» (n8n Cloud блокує $env);
   при ротації міняти В ОБОХ. Пісочниця n8n Cloud: доступний лише require('crypto')
   (немає dns/url/net). Джерело істини для нормалізації — RadFlow lib/priceImport.ts. */
const SECRET = 'REPLACE_ME_IMPORT_SECRET';
const crypto = require('crypto');
const item = $input.first();
const headers = item.json.headers || {};
const sigHeader = String(headers['x-radflow-signature'] || '');

let raw = null;
if (item.binary && item.binary.data) {
  if (typeof item.binary.data.data === 'string' && item.binary.data.data.length > 0) {
    raw = Buffer.from(item.binary.data.data, 'base64');
  } else if (this.helpers && typeof this.helpers.getBinaryDataBuffer === 'function') {
    raw = await this.helpers.getBinaryDataBuffer(0, 'data');
  }
}
if (!raw && typeof item.json.rawBody === 'string') {
  raw = Buffer.from(item.json.rawBody, 'utf8');
}
if (!raw && item.json.body && typeof item.json.body === 'object' && Object.keys(item.json.body).length > 0) {
  raw = Buffer.from(JSON.stringify(item.json.body), 'utf8');
}
if (!raw) throw new Error('IMPORT_NO_BODY: тіло запиту не отримано');

// ⚠️ НІКОЛИ не включати обчислений HMAC у текст помилки — це оракул підписування.
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const a = Buffer.from(expected, 'utf8');
const b = Buffer.from(sigHeader, 'utf8');
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
  throw new Error('IMPORT_BAD_SIGNATURE: підпис не пройшов перевірку');
}

const payload = JSON.parse(raw.toString('utf8'));
if (!payload || typeof payload !== 'object') throw new Error('IMPORT_BAD_PAYLOAD');

// L1 (ревʼю 3b): анти-replay — підписаний запит живе 5 хвилин.
const ts = Number(payload.ts);
if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
  throw new Error('IMPORT_STALE: запит протермінований — повторіть імпорт');
}

// 3b: kinds — xlsx/csv (детермінована гілка) + pdf/image/text/url (AI-гілка).
const KINDS = ['xlsx', 'csv', 'pdf', 'image', 'text', 'url'];
const kind = KINDS.includes(payload.kind) ? payload.kind : 'xlsx';
const out = { request_id: String(payload.request_id || ''), kind, filename: typeof payload.filename === 'string' ? payload.filename : '' };

if (kind === 'url') {
  /* SSRF-гард БЕЗ класа URL: у пісочниці n8n task-runner немає ні глобального URL,
     ні require('url') (whitelist — лише crypto). Перший рубіж із WHATWG-нормалізацією
     (127.1→127.0.0.1, hex-IP тощо) — safePriceUrl у RadFlow; тут дзеркало на regex:
     лише https, без userinfo/IPv6, хост — домен ІЗ КРАПКОЮ (не число/hex-IP,
     не localhost/.local). Редиректи Fetch Page ВИМКНЕНО (M1). Резолв DNS та блок
     приватних IP — на боці RadFlow (lib/ssrfGuard.ts), бо тут dns недоступний. */
  const rawUrl = String(payload.url || '').trim();
  const m = rawUrl.match(/^https:\/\/([^\/?#]+)([\/?#].*)?$/i);
  if (!m) throw new Error('IMPORT_BAD_URL: лише https-посилання');
  let hostPort = m[1].toLowerCase();
  if (hostPort.includes('@') || hostPort.includes('[') || hostPort.includes(']')) {
    throw new Error('IMPORT_BAD_URL: заборонений хост');
  }
  let host = hostPort;
  const pi = hostPort.indexOf(':');
  if (pi !== -1) {
    const port = hostPort.slice(pi + 1);
    if (!/^\d{1,5}$/.test(port)) throw new Error('IMPORT_BAD_URL: заборонений хост');
    host = hostPort.slice(0, pi);
  }
  host = host.replace(/\.$/, '');
  const numericOrHexIp = /^[0-9.]+$/.test(host) || host.includes('0x');
  if (!host || !host.includes('.') || host === 'localhost' || host.endsWith('.local')
      || numericOrHexIp || !/^[a-z0-9.-]+$/.test(host)) {
    throw new Error('IMPORT_BAD_URL: заборонений хост');
  }
  out.url = rawUrl;
  return [{ json: out }];
}

if (kind === 'text') {
  // Текст уже витягнуто на боці RadFlow (docx → text): у файл не загортаємо.
  const text = String(payload.text || '');
  if (!text.trim()) throw new Error('IMPORT_NO_TEXT: порожній текст');
  out.text = text.slice(0, 300000);
  return [{ json: out }];
}

if (typeof payload.file_b64 !== 'string' || !payload.file_b64) throw new Error('IMPORT_NO_FILE');
const MIMES = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  pdf: 'application/pdf',
};
let mime;
let ext = kind;
if (kind === 'image') {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  mime = allowed.includes(payload.mime) ? payload.mime : 'image/jpeg';
  out.mime = mime;
  ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
} else {
  mime = MIMES[kind];
}
const fileName = typeof payload.filename === 'string' && payload.filename ? payload.filename : ('price.' + ext);
const buf = Buffer.from(payload.file_b64, 'base64');
let binaryFile;
if (this.helpers && typeof this.helpers.prepareBinaryData === 'function') {
  binaryFile = await this.helpers.prepareBinaryData(buf, fileName, mime);
} else {
  binaryFile = { data: payload.file_b64, mimeType: mime, fileName };
}
out.filename = fileName;
return [{ json: out, binary: { file: binaryFile } }];
