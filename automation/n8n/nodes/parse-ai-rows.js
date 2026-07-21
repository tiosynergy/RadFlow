/* n8n Code-нода «Parse AI Rows» (workflow radflow-price-import). Секрету немає.
   3b: відповідь Grok → сирі AI-рядки (по одному item). Уся подальша нормалізація
   і класифікація — на боці RadFlow (lib/priceImport.ts parseAiRows). */
const resp = $input.first().json;
const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message ? resp.choices[0].message.content : null;
if (typeof content !== 'string' || !content) throw new Error('IMPORT_AI_EMPTY: модель не повернула відповіді');
let parsed;
try { parsed = JSON.parse(content); } catch { throw new Error('IMPORT_AI_BAD_JSON: відповідь моделі не JSON'); }
const items = Array.isArray(parsed && parsed.items) ? parsed.items.slice(0, 500) : [];
return items
  .filter((r) => r && typeof r === 'object' && !Array.isArray(r))
  .map((r) => ({ json: {
    name: r.name,
    modality: r.modality == null ? null : r.modality,
    price: r.price == null ? null : r.price,
    duration_min: r.duration_min == null ? null : r.duration_min,
    confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
  } }));
