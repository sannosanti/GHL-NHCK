'use strict';

// Barrido de citas fantasma: eventos vivos en GHL cuyo registro de Zoho ya no
// existe.
//
// POR QUE EXISTE. La sincronización Zoho -> GHL viaja por avisos sobre un
// registro: creación, modificación y los botones de estado. Un BORRADO no tiene
// por dónde viajar, porque al borrarse el registro desaparece lo único que
// podría avisarnos. El evento queda vivo en GHL, ocupa la franja, y el workflow
// de recordatorios le manda al paciente un mensaje por una cita que no existe.
// Tickets #1045, #1050 y #1052, los tres con pacientes molestos.
//
// POR QUE ES UN JOB Y NO UN SCRIPT. La primera versión corría a mano y después
// como tarea del escritorio de Santiago. El 3/11 se detectaron tres fantasmas,
// uno de ellos para el 6/11 a las 8:00, y la baja nunca llegó a ejecutarse: el
// comando manual no se corrió y la tarea del escritorio murió en su primer paso.
// El 5/11 ese mismo fantasma le mandó el recordatorio al paciente. La causa de
// fondo del segundo incidente no fue el borrado en Creator sino que la
// remediación dependía de una persona y de una máquina encendida. Acá adentro no
// depende de ninguna de las dos.
//
// ENCENDIDO POR DEFECTO. Al revés que reconciliacionCitasJob, que se envió a
// oscuras a propósito. Este corrige un daño que ya ocurrió tres veces y su
// escritura es una cancelación reversible; dejarlo detrás de una variable que
// hay que acordarse de encender repetiría el modo de falla que vino a tapar.
// Para apagarlo: BARRIDO_FANTASMAS=off.
const cron = require('node-cron');
const db = require('../db');
const zoho = require('../services/zoho');
const ghl = require('../services/ghl');
const { notify, notifyError } = require('../services/notifier');

const DIAS_POR_DEFECTO = 30;

// DOS CADENCIAS, y la razón es medida, no teórica. El 5/11 un barrido a las
// 10:00 UTC encontró 3 fantasmas y otro a las 19:54 UTC encontró 7: cinco
// registros se borraron en Creator dentro de la misma jornada. Como los
// recordatorios salen 24 horas antes de cada cita y por lo tanto a cualquier
// hora del día, una sola pasada diaria deja desprotegido todo lo que se borre
// después de ella.
//
// La pasada frecuente mira sólo los próximos días, que es donde un borrado
// alcanza a hacer daño antes de la siguiente corrida: son tres llamadas a Zoho
// y se puede repetir seguido sin acercarse a la cuota, que ya se agotó una vez
// el 2026-08-20 y dejó al bot sin agenda por horas.
//
// La pasada completa barre el mes entero una vez al día. El servidor corre en
// UTC y Bogotá es UTC-5, así que 10:00 UTC son las 5:00 de la mañana allá: tres
// horas de margen antes del recordatorio más temprano, el de las citas de 8:00.
const CRON_COMPLETO = '0 10 * * *';
const DIAS_COMPLETO = 30;
const CRON_CERCANO = '0 * * * *';
const DIAS_CERCANO = 3;

// Una pasada al arrancar, para que un deploy no deje el día sin barrer. Se
// espera un poco a que el proceso termine de levantar.
const PRIMERA_PASADA_MS = 3 * 60 * 1000;

const MESES_ZOHO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dos = (n) => String(n).padStart(2, '0');
const aZoho = (d) => `${dos(d.getDate())}-${MESES_ZOHO[d.getMonth()]}-${d.getFullYear()}`;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * IDs de cita que siguen existiendo en Zoho en el rango.
 * Se recorre día por día: Zoho pagina de a 200 y un rango largo se topa con el
 * tope sin avisar, además de que así un fallo puntual se ubica en su día.
 */
async function idsVivosEnZoho(desde, dias) {
  const tok = await zoho.getZohoAccessToken();
  const vivos = new Set();
  for (let i = 0; i < dias; i++) {
    const d = new Date(desde.getTime() + i * 86400000);
    const crit = `Inicio >= "${aZoho(d)} 00:00:00" && Inicio <= "${aZoho(d)} 23:59:59"`;
    const url = 'https://creator.zoho.com/api/v2/visionintegralceo/calendario/report/Citas_Report'
      + `?criteria=${encodeURIComponent(crit)}&max_records=200`;
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${tok}` } });
    if (r.status === 404) continue;               // 404 = ese día no tiene registros
    if (!r.ok) {
      // Un día que no se pudo leer NO puede tratarse como "sin citas": cada
      // registro de ese día parecería borrado y se cancelarían citas reales.
      // Abortar entero es la única opción segura.
      throw new Error(`Zoho respondió HTTP ${r.status} para ${aZoho(d)}`);
    }
    for (const c of ((await r.json()).data || [])) vivos.add(String(c.ID));
    await dormir(150);
  }
  return vivos;
}

async function barrerFantasmas({ dias = DIAS_POR_DEFECTO, cancelar = true } = {}) {
  const stats = { revisadas: 0, fantasmas: 0, canceladas: 0, fallidas: 0, detalle: [] };
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const vivos = await idsVivosEnZoho(hoy, dias);

  // Sólo citas de paciente: un bloqueo huérfano no tiene contacto y no le manda
  // nada a nadie, así que cancelarlo sería tocar la agenda sin beneficio.
  const { rows } = await db.pool.query(`
    SELECT zoho_cita_id, ghl_event_id, inicio
    FROM citas_sync
    WHERE ghl_event_id IS NOT NULL
      AND clase = 'cita'
      AND to_timestamp(inicio, 'DD-Mon-YYYY HH24:MI:SS') >= now()::date
      AND to_timestamp(inicio, 'DD-Mon-YYYY HH24:MI:SS') < now()::date + $1::int
    ORDER BY to_timestamp(inicio, 'DD-Mon-YYYY HH24:MI:SS')`, [dias]);

  stats.revisadas = rows.length;
  const fantasmas = rows.filter((r) => !vivos.has(String(r.zoho_cita_id)));
  stats.fantasmas = fantasmas.length;
  if (!fantasmas.length) return stats;

  for (const f of fantasmas) {
    stats.detalle.push({ inicio: f.inicio, ghl: f.ghl_event_id, zoho: f.zoho_cita_id });
    if (!cancelar) continue;
    try {
      // Se relee el evento antes de escribir: el PUT de GHL reemplaza el
      // recurso entero, así que hay que reenviarle su calendario, título y
      // contacto o se pierden.
      const actual = await ghl.getCitaEnCalendario(f.ghl_event_id);
      if (!actual) {
        await db.pool.query('DELETE FROM citas_sync WHERE ghl_event_id=$1', [f.ghl_event_id]);
        stats.canceladas++;
        continue;
      }
      const ok = await ghl.actualizarCitaEnCalendario({
        eventId: f.ghl_event_id,
        calendarId: actual.calendarId,
        contactId: actual.contactId,
        startISO: actual.startTime,
        endISO: actual.endTime,
        title: actual.title,
        description: actual.notes || actual.description || '',
        // Cancelar y no borrar: deja rastro en la agenda y se revierte si
        // resulta que el registro se borró por error.
        appointmentStatus: 'cancelled',
      });
      if (ok === false) throw new Error('GHL rechazó la actualización');
      await db.pool.query('DELETE FROM citas_sync WHERE ghl_event_id=$1', [f.ghl_event_id]);
      await db.logEvent(actual.contactId || null, null, 'cita_fantasma_cancelada',
        { ghl_event_id: f.ghl_event_id, zoho_cita_id: f.zoho_cita_id, inicio: f.inicio }).catch(() => {});
      stats.canceladas++;
      stats.detalle[stats.detalle.length - 1].contacto = actual.contactId || null;
    } catch (err) {
      console.error(`[barridoFantasmas] no se pudo cancelar ${f.ghl_event_id}: ${err.message}`);
      stats.fallidas++;
    }
    await dormir(250);
  }
  return stats;
}

async function runBarridoFantasmasJob(dias = DIAS_COMPLETO) {
  let stats;
  try {
    stats = await barrerFantasmas({ dias });
  } catch (err) {
    // Que Zoho no se pueda leer importa: significa que hoy el barrido no
    // protegió a nadie, y el recordatorio sale igual dentro de unas horas.
    console.error('[barridoFantasmas] abortado:', err.message);
    await notifyError('barridoFantasmas', err).catch(() => {});
    return null;
  }

  console.log(`[barridoFantasmas] (${dias}d) revisadas ${stats.revisadas} | fantasmas ${stats.fantasmas} | canceladas ${stats.canceladas} | fallidas ${stats.fallidas}`);
  if (!stats.fantasmas) return stats;

  // El aviso sólo sale cuando hubo algo. Un barrido limpio todos los días
  // entrena al equipo a ignorar el canal.
  const hoyISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const urgentes = stats.detalle.filter((d) => {
    const dia = String(d.inicio || '').slice(0, 11);
    const manana = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    return [hoyISO, manana].some((iso) => {
      const [a, m, dd] = iso.split('-');
      return dia === `${dd}-${MESES_ZOHO[Number(m) - 1]}-${a}`;
    });
  });

  await notify(
    `*Citas fantasma dadas de baja*\n`
    + `Canceladas: ${stats.canceladas} de ${stats.fantasmas} (revisadas ${stats.revisadas} citas futuras)\n`
    + (stats.fallidas ? `No se pudieron cancelar: ${stats.fallidas}\n` : '')
    + stats.detalle.map((d) => `• ${d.inicio} — contacto ${d.contacto || 'sin contacto'}`).join('\n')
    + (urgentes.length
      ? `\n\n*${urgentes.length} ${urgentes.length === 1 ? 'es' : 'son'} de hoy o mañana: el paciente ya recibió o está por recibir el recordatorio. Cancelarla acá no deshace el mensaje — hay que llamarlo.*`
      : '')
    + `\n${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`,
  ).catch(() => {});

  return stats;
}

function startBarridoFantasmasJob() {
  const activo = process.env.BARRIDO_FANTASMAS !== 'off';
  console.log(`Barrido de citas fantasma: ${activo
    ? `ACTIVO — cercano ${CRON_CERCANO} (${DIAS_CERCANO}d), completo ${CRON_COMPLETO} (${DIAS_COMPLETO}d), en UTC`
    : 'apagado (BARRIDO_FANTASMAS=off)'}`);
  if (!activo) return;

  const correr = (dias) => () => runBarridoFantasmasJob(dias)
    .catch((err) => console.error('[barridoFantasmas] Unhandled error:', err.message));

  cron.schedule(CRON_CERCANO, correr(DIAS_CERCANO));
  cron.schedule(CRON_COMPLETO, correr(DIAS_COMPLETO));
  setTimeout(correr(DIAS_COMPLETO), PRIMERA_PASADA_MS);
}

module.exports = { startBarridoFantasmasJob, runBarridoFantasmasJob, barrerFantasmas };
