// Muestra la respuesta CRUDA de Zoho. getDisponibilidad hace `data.data || []`,
// así que un 401 o un rate limit se ven exactamente igual que un día sin citas.
// Cuando la agenda aparece vacía sin motivo, esto dice qué está pasando.
//
//   node scripts/calendario/diagnostico-zoho.js 2026-08-20
const zoho = require('../../services/zoho');

(async () => {
  const dia = process.argv[2] || new Date().toISOString().slice(0, 10);
  const token = await zoho.getZohoAccessToken();
  console.log(`token obtenido: ${token ? `sí (${String(token).length} car.)` : 'NO'}`);

  const criteria = `(Inicio >= "${dia} 00:00:00" && Inicio <= "${dia} 23:59:59")`;
  const url = `https://creator.zoho.com/api/v2/visionintegralceo/calendario/report/Citas_Report?criteria=${encodeURIComponent(criteria)}`;
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  console.log(`HTTP ${res.status} ${res.statusText}`);
  const texto = await res.text();
  console.log(texto.slice(0, 600));
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
