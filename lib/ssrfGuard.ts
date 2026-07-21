/* ===== RadFlow — SSRF-гард резолву хоста (Stage 2, фаза 3b hardening) =====
   Синтаксичний гард `safePriceUrl` (lib/priceImport.ts) + дзеркало в n8n
   «Verify & Decode» відсікають IP-літерали/localhost/IPv6/не-https. Але
   ДОМЕННЕ імʼя, що резолвиться в приватну/зарезервовану адресу
   (10/8, 172.16/12, 192.168/16, 169.254/16 вкл. 169.254.169.254, loopback,
   IPv6 ULA/link-local), проходило б обидва гарди — бо жоден бік не резолвив DNS.

   Цей модуль РЕЗОЛВИТЬ хост на боці RadFlow ДО відправки в n8n і відмовляє,
   якщо будь-яка отримана адреса не є публічною (fail-closed). Це підіймає планку:
   домен має резолвитись у публічний IP на момент перевірки. DNS-rebinding (TOCTOU)
   повністю НЕ закриває — нода n8n «Fetch Page» резолвить хост повторно за секунди
   після нас, — але разом із вимкненими редиректами (M1) вікно експлуатації вузьке.
   Повний pin-резолв недоступний: у пісочниці n8n Cloud немає ні dns, ні url.

   Живе ОКРЕМО від priceImport.ts: той модуль чистий (edge/клієнт-safe), а тут —
   Node `dns/promises`. Імпортується лише серверним роутом /api/services/import.
   Чиста логіка (isPublicIp) покрита vitest; резолв — контрактним тестом (мок dns). */

import { lookup } from "dns/promises";

/* ---------------- IPv4 ---------------- */

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return null;
  return (((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
}

/** Не-публічні (приватні/зарезервовані/спец) IPv4-блоки за IANA. */
const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],       // «this network»
  ["10.0.0.0", 8],      // private
  ["100.64.0.0", 10],   // CGNAT
  ["127.0.0.0", 8],     // loopback
  ["169.254.0.0", 16],  // link-local (169.254.169.254 = cloud metadata)
  ["172.16.0.0", 12],   // private
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["192.0.2.0", 24],    // TEST-NET-1
  ["192.88.99.0", 24],  // 6to4 relay anycast
  ["192.168.0.0", 16],  // private
  ["198.18.0.0", 15],   // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24],  // TEST-NET-3
  ["224.0.0.0", 4],     // multicast
  ["240.0.0.0", 4],     // reserved / 255.255.255.255 broadcast
];

function isPublicIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of V4_BLOCKS) {
    const b = ipv4ToInt(base);
    if (b === null) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (b & mask) >>> 0) return false;
  }
  return true;
}

/* ---------------- IPv6 ---------------- */

/** Розгортає IPv6 у рівно 8 груп по 16 біт (обробляє "::" і вбудовану IPv4).
    Некоректний рядок → null. Це прибирає залежність від канонічної компресії:
    "0:0:0:0:0:0:0:1" і "::1" дають однаковий результат. */
function expandIpv6(input: string): number[] | null {
  let s = input;
  // Вбудована IPv4 (mapped/nat64/v4-compat) → у дві hex-групи для однакового аналізу.
  const v4 = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const p = v4[2].split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    const hex = (((p[0] << 8) | p[1]) & 0xffff).toString(16) + ":" + (((p[2] << 8) | p[3]) & 0xffff).toString(16);
    s = v4[1] + hex;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // "::" мусить стискати ≥1 групу
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  const out = groups.map((g) => (g === "" ? NaN : parseInt(g, 16)));
  if (out.length !== 8 || out.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
  return out;
}

function isPublicIpv6(raw: string): boolean {
  const g = expandIpv6(raw.toLowerCase().split("%")[0]); // прибрати zone-id (fe80::1%eth0)
  if (!g) return false;

  const embeddedV4 = () => `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
  const zeroThrough5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;

  // Вбудована IPv4 — перевіряємо саму IPv4 (інакше приватна пролізла б в обгортці).
  if (zeroThrough5 && g[5] === 0xffff) return isPublicIpv4(embeddedV4()); // ::ffff:x  (mapped)
  if (zeroThrough5 && g[5] === 0) {
    if (g[6] === 0 && g[7] === 0) return false; // ::  unspecified
    if (g[6] === 0 && g[7] === 1) return false; // ::1 loopback
    return isPublicIpv4(embeddedV4());          // ::x.x.x.x  (deprecated v4-compat)
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicIpv4(embeddedV4()); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) {
    return isPublicIpv4(`${(g[1] >> 8) & 0xff}.${g[1] & 0xff}.${(g[2] >> 8) & 0xff}.${g[2] & 0xff}`); // 2002::/16 6to4
  }

  if ((g[0] & 0xfe00) === 0xfc00) return false;             // fc00::/7  ULA
  if ((g[0] & 0xffc0) === 0xfe80) return false;             // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false;             // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false;             // ff00::/8  multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;     // 2001:db8::/32 documentation

  return true;
}

/* ---------------- API ---------------- */

/** true лише для маршрутизованих ПУБЛІЧНИХ unicast-адрес (IPv4 або IPv6).
    Чиста функція — під vitest. Невалідний рядок → false (fail-closed). */
export function isPublicIp(ip: string): boolean {
  if (typeof ip !== "string" || !ip) return false;
  return ip.includes(":") ? isPublicIpv6(ip) : isPublicIpv4(ip);
}

/** Резолвить хост (A+AAAA) і повертає true, ЛИШЕ якщо є ≥1 адреса і ВСІ вони
    публічні. DNS-помилка / порожній результат / будь-яка приватна адреса → false
    (fail-closed). Вживається у route.ts для режиму «посилання на прайс» (3b). */
export async function hostResolvesPublic(host: string): Promise<boolean> {
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return false;
  }
  if (!addrs.length) return false;
  return addrs.every((a) => isPublicIp(a.address));
}
