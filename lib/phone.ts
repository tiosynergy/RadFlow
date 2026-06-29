/* ===== RadFlow — телефони (формат + валідація у стилі Apple iOS) =====
   iOS форматує номер «на льоту» під час набору і підсвічує некоректний.
   Тут — українська локаль: міжнародний (+380 XX XXX XX XX) та місцевий
   (0XX XXX XX XX) формати. Національний значущий номер — рівно 9 цифр. */

/** Національні значущі цифри (без 380 / без ведучого 0), максимум 9. */
export function phoneDigitsUA(input: string): string {
  let d = (input || "").replace(/\D/g, "");
  if (d.startsWith("380")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  return d.slice(0, 9);
}

/** Згрупувати 9 цифр як XX XXX XX XX (як на iOS). */
function group(nsn: string): string {
  return [nsn.slice(0, 2), nsn.slice(2, 5), nsn.slice(5, 7), nsn.slice(7, 9)]
    .filter(Boolean)
    .join(" ");
}

/**
 * Форматування «as-you-type». Якщо користувач почав із «+» або «380» —
 * показуємо міжнародний формат «+380 XX XXX XX XX», інакше місцевий
 * «0XX XXX XX XX». Порожній рядок лишається порожнім.
 */
export function formatPhoneUA(input: string): string {
  if (!input) return "";
  const raw = input.replace(/\D/g, "");
  const intl = input.trim().startsWith("+") || raw.startsWith("380");
  const nsn = phoneDigitsUA(input);
  if (intl) return "+380" + (nsn ? " " + group(nsn) : "");
  if (!nsn) return input.trim().startsWith("+") ? "+380 " : "";
  return "0" + group(nsn);
}

/** Чи є номер повним і коректним (рівно 9 національних цифр). */
export function isValidPhoneUA(input: string): boolean {
  return phoneDigitsUA(input).length === 9;
}

/** Канонічний E.164 (+380XXXXXXXXX), якщо номер валідний; інакше — як є. */
export function normalizePhoneUA(input: string): string {
  const d = phoneDigitsUA(input);
  return d.length === 9 ? "+380" + d : (input || "").trim();
}
