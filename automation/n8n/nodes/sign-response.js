/* n8n Code-нода «Sign Response» (workflow radflow-price-import).
   ⚠️ РЕДАКТОВАНО ДЛЯ РЕПО: SECRET замінено на REPLACE_ME_IMPORT_SECRET
   (той самий секрет, що й у «Verify & Decode» — при ротації міняти В ОБОХ). */
const SECRET = 'REPLACE_ME_IMPORT_SECRET';
const crypto = require('crypto');
const meta = $('Verify & Decode').first().json;
const AI_KINDS = ['pdf', 'image', 'text', 'url'];
const rows = $input.all()
  .map(i => i.json)
  .filter(r => r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length > 0);
const body = JSON.stringify({ request_id: meta.request_id, rows, ai: AI_KINDS.includes(meta.kind) });
const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
return [{ json: { body, sig } }];
