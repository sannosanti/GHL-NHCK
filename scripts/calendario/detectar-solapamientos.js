'use strict';

/**
 * Lista las citas de Zoho que se pisan entre sí sobre el mismo consultor o
 * recurso. Confirmado con el centro el 2026-08-12: nadie atiende a dos personas
 * a la vez, así que todo solapamiento es un conflicto de agenda real.
 *
 * Nace de un diagnóstico equivocado: en GHL se veían "citas duplicadas" y
 * parecían un fallo del espejado. No lo eran -- Zoho tenía pacientes distintos
 * reservados en el mismo horario, y la sincronización sólo los hizo visibles.
 *
 * Compara intervalos y no sólo la hora de inicio: una de 08:00-09:30 y otra de
 * 08:30-10:00 se pisan igual, y ese caso no aparece agrupando por Inicio.
 *
 *   railway run node scripts/calendario/detectar-solapamientos.js 2026-08-13 2026-08-14 2026-08-15
 */

const fetch = require('node-fetch');
const { getZohoAccessToken } = require('../../services/zoho');
const { parseZohoDateTime } = require('../../webhooks/zoho');

const ms = z => { const iso = parseZohoDateTime(z); const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const hhmm = z => String(z || '').slice(12, 17);

async function citasDelDia(token, iso) {
  const criteria = `(Inicio >= "${iso} 00:00:00" && Inicio <= "${iso} 23:59:59")`;
  const url = `https://creator.zoho.com/api/v2/visionintegralceo/calendario/report/Citas_Report`
    + `?criteria=${encodeURIComponent(criteria)}&max_records=200`;
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (!res.ok) throw new Error(`Citas_Report devolvió HTTP ${res.status}`);
  return (await res.json()).data || [];
}

async function main() {
  const dias = process.argv.slice(2);
  if (!dias.length) {
    console.error('Uso: node detectar-solapamientos.js 2026-08-13 [2026-08-14 ...]');
    process.exitCode = 1;
    return;
  }

  const token = await getZohoAccessToken();
  const citas = [];
  for (const d of dias) citas.push(...await citasDelDia(token, d));
  console.log(`${citas.length} registros en Zoho para ${dias.join(', ')}\n`);

  // Agrupar por consultor: el solapamiento sólo importa dentro del mismo recurso.
  const porConsultor = {};
  for (const c of citas) {
    const quien = c.Consultor?.display_value || c.Consultor || '(sin consultor)';
    (porConsultor[quien] ||= []).push(c);
  }

  let total = 0;
  for (const [quien, lista] of Object.entries(porConsultor).sort()) {
    const conFecha = lista
      .map(c => ({ c, ini: ms(c.Inicio), fin: ms(c.Fin) }))
      .filter(x => x.ini !== null)
      .sort((a, b) => a.ini - b.ini);

    const choques = [];
    for (let i = 0; i < conFecha.length; i++) {
      for (let j = i + 1; j < conFecha.length; j++) {
        const a = conFecha[i], b = conFecha[j];
        // Sin Fin no se puede afirmar solapamiento; sólo cuenta el inicio idéntico.
        const seSolapan = (a.fin && b.fin) ? (b.ini < a.fin && a.ini < b.fin) : (a.ini === b.ini);
        if (seSolapan) choques.push([a, b]);
      }
    }
    if (!choques.length) continue;

    console.log(`\n=== ${quien} — ${choques.length} choque(s) ===`);
    for (const [a, b] of choques) {
      const dia = String(a.c.Inicio).slice(0, 11);
      console.log(`  ${dia}`);
      for (const x of [a, b]) {
        const nombre = x.c.Contacto?.display_value || `(${x.c.Tipo || 'sin tipo'}: ${String(x.c.Observaciones || '').slice(0, 40) || 'sin detalle'})`;
        console.log(`     ${hhmm(x.c.Inicio)}-${hhmm(x.c.Fin)}  ${String(x.c.Tipo || '?').padEnd(11)} ${nombre}   [${x.c.ID}]`);
      }
    }
    total += choques.length;
  }

  console.log(`\n\nTOTAL: ${total} solapamiento(s) en ${dias.length} día(s)`);
}

main().catch(err => { console.error('Error:', err.message); process.exitCode = 1; });
