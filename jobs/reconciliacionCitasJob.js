'use strict';

const db = require('../db');
const zoho = require('../services/zoho');
const ghl = require('../services/ghl');
const { notify, notifyError } = require('../services/notifier');
// El ruteo Consultor -> calendario viene del webhook, no se copia: mientras
// existieron dos mapas, agregar un consultor en uno y olvidarlo en el otro dejaba
// sus citas en CALENDAR_GENERAL sin que nadie lo notara. La reconciliación tiene
// que rutear exactamente igual que el webhook o crea la cita en otra agenda.
const { refZoho, parseZohoDateTime, tituloGHL, CALENDARIOS, CALENDAR_GENERAL } = require('../webhooks/zoho');

// Zoho's "Replicar" custom action inserts Citas records by script, which does
// NOT count as a form submission — so Zoho's "GHL" workflow (trigger: "Creado ->
// Envío de formulario correcto") never fires and webhooks/zoho.js's
// zohoCitaWebhookHandler is never even called. On 2026-09-18, 54 appointments
// were created in Zoho and only 31 reached GHL: 20 of the 23 losses were bulk
// "Replicar" bursts, the other 3 were individual webhook failures. A patient
// whose appointment never reaches GHL gets no confirmation and no reminder, and
// nobody finds out until they complain.
//
// This job is the safety net: it walks the same window the booking flow can
// create appointments in, finds Zoho appointments with no matching citas_sync
// row, and mirrors them into GHL the same way the webhook would have. It never
// touches block-slots (Tipo === 'Bloqueo' or no Contacto) — those are out of
// scope for v1.


// ─── LÍMITES DE SEGURIDAD ─────────────────────────────────────────────────────

// A first run can face days of accumulated backlog — the incident that
// motivated this job lost 23 appointments in a single day. Capping how many
// get created per pass means a first run catches up over a few passes instead
// of firing dozens of "tu cita está confirmada" messages at once.
const MAX_POR_PASADA = 10;

// Space out the GHL calls that each fire an instant confirmation message, so a
// backlog doesn't read as a burst of messages arriving together.
const PAUSA_ENTRE_CREACIONES_MS = 500;

// A run of failures almost always means something systemic (Zoho or GHL down,
// an expired token) rather than three unlucky rows in a row. Aborting the pass
// avoids burning the rest of the 45-day window retrying a failure that won't
// resolve itself mid-pass — the next pass in 30 minutes tries again fresh.
const MAX_FALLOS_CONSECUTIVOS = 3;

// Creating an appointment fires GHL's confirmation workflow instantly (see
// guardarFechaCitaTextoGHL below). Nobody should get "tu cita está confirmada"
// for something that already happened or is about to.
const MARGEN_MINIMO_MS = 2 * 60 * 60 * 1000; // 2 horas

// A citas_sync row with no ghl_event_id yet could just be a webhook mid-flight:
// reclamarCitaZoho already reserved the row and crearCitaEnCalendario hasn't
// returned. Racing it would create a duplicate. Anything older than this is
// assumed to be a webhook that reserved the row and then died before confirming.
const RESERVA_EN_VUELO_MS = 10 * 60 * 1000; // 10 minutos

// How far ahead to scan. Long enough to catch appointments booked well in
// advance, short enough that a single pass stays a bounded, predictable cost.
const DIAS_VENTANA = 45;

const PRIMERA_PASADA_MS = 5 * 60 * 1000;  // ~5 minutos después del boot
const INTERVALO_MS = 30 * 60 * 1000;      // cada 30 minutos — 48 pasadas/día

// El caso "sin Movil" solía avisar por Cliq una vez por caso además del
// resumen de la pasada, y como liberarCitaZoho deja la cita lista para que la
// próxima pasada la vuelva a detectar, un solo registro roto generaba hasta 48
// avisos por día. Ahora se nombra sólo dentro del resumen, y como máximo una
// vez por vida del proceso — este Set en memoria recuerda cuáles ya se
// nombraron. Se reinicia en cada redeploy a propósito: no vale la pena una
// tabla sólo para esto, y un redeploy es justo el momento en que conviene
// volver a mencionar lo que sigue sin resolver.
const sinMovilYaNombrados = new Set();

// setInterval no espera a que termine su callback async, y ni fetchGHL ni las
// llamadas a Zoho fijan un timeout de request (node-fetch v2 no trae uno por
// defecto), así que una llamada colgada puede hacer que una pasada dure más
// que los 30 minutos del intervalo. Esta bandera evita que dos pasadas corran
// en paralelo — lo que haría que compitan por las mismas reservas de
// citas_sync y arriesgaran un duplicado — en vez de intentar acertarle a un
// timeout para llamadas que no lo controlamos del todo.
let enCurso = false;

// Colombia no tiene horario de verano (UTC-5 todo el año), así que sumar días en
// milisegundos y formatear con timeZone alcanza sin más lógica de calendario.
function fechaBogota(offsetDias) {
  const fecha = new Date(Date.now() + offsetDias * 24 * 60 * 60 * 1000);
  return fecha.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // YYYY-MM-DD
}

/**
 * Intenta espejar una única cita de Zoho detectada como faltante. Sigue el
 * mismo orden que zohoCitaWebhookHandler para los pasos que ese orden importa
 * (reservar -> resolver contacto Zoho -> resolver contacto GHL -> guardar la
 * fecha en español -> crear -> confirmar), con UN agregado: un chequeo de
 * sólo lectura contra el calendario de GHL, insertado justo antes de los pasos
 * que mutan algo — porque citas_sync puede estar incompleta para citas que los
 * scripts de migración de agosto espejaron directo (ver
 * scripts/calendario/poblar-citas-sync.js). Que falte la fila acá NO prueba que
 * falte el evento en GHL, y perder una pasada de reconciliación es recuperable;
 * crear una cita duplicada para un paciente no lo es.
 *
 * A diferencia del webhook, esta función NUNCA degrada una cita a bloqueo: un
 * bloqueo no tiene contacto ni recordatorio, y degradar en silencio taparía
 * exactamente la pérdida que este job existe para exponer.
 *
 * Devuelve una etiqueta corta para los contadores de quien llama. Lanza ante
 * cualquier fallo real, para que el caller libere la reserva y lo cuente como
 * fallo de verdad.
 */
async function reconciliarCitaFaltante({ zohoCitaID, contactoRef, calendarId, startISO, endISO, cita }) {
  if (!(await db.reclamarCitaZoho(zohoCitaID, 'cita'))) {
    // Otro worker (el webhook, u otra instancia de este job) la reservó entre
    // nuestra lectura de getCitaSync y este intento. Ya no es nuestra.
    return 'ganada-por-otro';
  }

  const contacto = await zoho.getContactoPorId(contactoRef);

  if (!contacto?.Movil) {
    await db.liberarCitaZoho(zohoCitaID);
    // Sin notify() individual acá a propósito — ver sinMovilYaNombrados más
    // arriba. Se libera igual para que la reconciliación se recupere sola en
    // cuanto alguien cargue el Movil en Zoho; sólo cambia CÓMO se avisa.
    console.error(`[reconciliacionCitasJob] ${zohoCitaID}: contacto ${contactoRef} sin Movil — NO se crea, este job nunca degrada a bloqueo`);
    return 'sin-movil';
  }

  const ghlContactId = await ghl.buscarOCrearContactoPorTelefono(contacto.Movil, contacto.Nombre_Completo);
  if (!ghlContactId) {
    throw new Error(`no se pudo resolver el contacto GHL para el Movil ${contacto.Movil}`);
  }

  const existente = await ghl.buscarCitaExistenteEnCalendario({ calendarId, contactId: ghlContactId, startISO, endISO });
  if (existente) {
    // Ya estaba en GHL — citas_sync sólo le faltaba la fila. Se completa acá en
    // vez de dejarla "faltante" para siempre: si no, cada pasada de las
    // próximas 45 ventanas repetiría esta misma consulta a GHL para nada.
    await db.confirmarCitaZoho(zohoCitaID, existente.id, calendarId, cita.Inicio, cita.Fin, 'cita');
    console.log(`[reconciliacionCitasJob] ${zohoCitaID} ya existía en GHL (evento ${existente.id}) — citas_sync completada`);
    return 'ya-en-ghl';
  }

  const tipo = cita.Tipo || 'Cita';
  const titulo = tituloGHL([tipo, contacto.Nombre_Completo || 'NHC'], 'Cita');

  // OBLIGATORIO antes de crear: crearCitaEnCalendario dispara el workflow de
  // confirmación al instante, y esa plantilla lee contact.cita_fecha_texto — sin
  // esto el paciente recibe la fecha de otra cita.
  await ghl.guardarFechaCitaTextoGHL(ghlContactId, startISO);
  const appt = await ghl.crearCitaEnCalendario({
    contactId: ghlContactId, calendarId, startISO, endISO, title: titulo, description: cita.Observaciones || '',
  });
  await db.confirmarCitaZoho(zohoCitaID, appt?.id, calendarId, cita.Inicio, cita.Fin, 'cita');

  await db.logEvent(null, null, 'cita_reconciliada', {
    zohoCitaID, ghlEventId: appt?.id, calendarId, inicio: cita.Inicio, fin: cita.Fin,
  }).catch(() => {});

  return 'creada';
}

async function runReconciliacionCitasJob() {
  if (enCurso) {
    console.log('[reconciliacionCitasJob] La pasada anterior todavía está corriendo — se salta esta invocación');
    return null;
  }
  enCurso = true;
  try {
    return await ejecutarPasada();
  } finally {
    // finally, no al final del try: si algo revienta antes de llegar al
    // return de abajo, la bandera tiene que bajar igual o el job queda
    // trabado "en curso" para siempre y ninguna pasada futura vuelve a correr.
    enCurso = false;
  }
}

async function ejecutarPasada() {
  const stats = { faltantes: 0, creadas: 0, fallidas: 0, sinMovil: 0, sinMovilNuevos: [] };
  let fallosConsecutivos = 0;
  let diasFallidos = 0;
  const diasTotal = DIAS_VENTANA + 1;

  pasada:
  for (let i = 0; i < diasTotal; i++) {
    const fechaISO = fechaBogota(i);

    let citas;
    try {
      citas = await zoho.getDisponibilidad(fechaISO);
    } catch (err) {
      diasFallidos++;
      console.error(`[reconciliacionCitasJob] Zoho ilegible para ${fechaISO} — se sigue con el próximo día:`, err.message);
      continue;
    }

    for (const c of citas) {
      // Este job sólo maneja citas de pacientes en v1 — los bloqueos quedan fuera.
      if (c.Tipo === 'Bloqueo') continue;
      const contactoRef = refZoho(c.Contacto);
      if (!contactoRef) continue;

      const startISO = parseZohoDateTime(c.Inicio);
      const endISO = parseZohoDateTime(c.Fin);
      if (!startISO || !endISO) {
        console.error(`[reconciliacionCitasJob] Horario ilegible en ${c.ID || 'sin ID'}: Inicio=${c.Inicio} Fin=${c.Fin}`);
        continue;
      }
      // Crear dispara la confirmación al instante — nadie debe recibirla para
      // algo que ya pasó o está por pasar.
      if (new Date(startISO).getTime() - Date.now() < MARGEN_MINIMO_MS) continue;

      const zohoCitaID = c.ID;
      if (!zohoCitaID) continue;

      const previo = await db.getCitaSync(zohoCitaID);
      if (previo?.ghl_event_id) continue; // ya espejada

      if (previo) {
        // edad_segundos viene calculado en SQL (ver db/index.js getCitaSync) y
        // no se resta acá con `created_at`: esa columna es TIMESTAMP WITHOUT
        // TIME ZONE y pg la interpreta con la zona horaria local del proceso
        // Node, así que un desfase entre Postgres y Node corre la edad horas
        // enteras — una reserva realmente en vuelo podría verse "vieja", y
        // este job terminaría soltando la reserva de OTRO worker y creando la
        // cita por duplicado.
        const edadMs = Number(previo.edad_segundos) * 1000;
        if (edadMs < RESERVA_EN_VUELO_MS) continue; // probablemente un webhook en vuelo — no competir
        await db.liberarCitaZoho(zohoCitaID); // reserva vieja sin evento: intento fallido, se trata como faltante
      }

      stats.faltantes++;

      if (stats.creadas >= MAX_POR_PASADA) continue; // tope alcanzado — se cuenta y se deja para la próxima pasada

      const consultorID = refZoho(c.Consultor);
      const calendarId = CALENDARIOS[consultorID] || CALENDAR_GENERAL;

      try {
        const resultado = await reconciliarCitaFaltante({ zohoCitaID, contactoRef, calendarId, startISO, endISO, cita: c });
        fallosConsecutivos = 0;
        if (resultado === 'creada') {
          stats.creadas++;
          await new Promise(r => setTimeout(r, PAUSA_ENTRE_CREACIONES_MS));
        } else if (resultado === 'sin-movil') {
          stats.sinMovil++;
          if (!sinMovilYaNombrados.has(zohoCitaID)) {
            sinMovilYaNombrados.add(zohoCitaID);
            stats.sinMovilNuevos.push(zohoCitaID);
          }
        }
      } catch (err) {
        fallosConsecutivos++;
        stats.fallidas++;
        await db.liberarCitaZoho(zohoCitaID);
        console.error(`[reconciliacionCitasJob] Falló ${zohoCitaID}:`, err.message);
        await db.logEvent(null, null, 'cita_reconciliacion_fallida', {
          zohoCitaID, motivo: err.message, inicio: c.Inicio, fin: c.Fin,
        }).catch(() => {});

        if (fallosConsecutivos >= MAX_FALLOS_CONSECUTIVOS) {
          console.error('[reconciliacionCitasJob] 3 fallos consecutivos — se aborta el resto de la pasada');
          break pasada;
        }
      }
    }
  }

  // Si NINGÚN día se pudo leer, es una caída de Zoho o de la cuota — no un caso
  // "no hay citas faltantes". La regla de "nunca avisar si no hay nada" es para
  // pasadas vacías, no para pasadas que no pudieron ni mirar.
  if (diasFallidos === diasTotal) {
    await notifyError('reconciliacionCitasJob', new Error(
      `No se pudo leer Zoho para ninguno de los ${diasTotal} días del rango — posible caída o límite de API agotado`
    )).catch(() => {});
    return stats;
  }

  // Corre 48 veces por día — un aviso en cada pasada vacía sería puro ruido.
  // Pero una caída PARCIAL de Zoho (algunos días fallan, otros no) no cuenta
  // como "pasada vacía" aunque stats.faltantes dé 0: los días que sí se
  // leyeron pueden simplemente no haber tenido nada, mientras el resto queda
  // sin revisar y el hueco pasa desapercibido hasta que alguien se queja.
  if (stats.faltantes > 0 || diasFallidos > 0) {
    await notify(
      `Reconciliación de citas Zoho -> GHL\n` +
      `Faltantes detectadas: ${stats.faltantes}\n` +
      `Creadas: ${stats.creadas}\n` +
      `Fallidas: ${stats.fallidas}\n` +
      `Sin Movil (no se crearon): ${stats.sinMovil}` +
      (stats.sinMovilNuevos.length ? ` — nuevas: ${stats.sinMovilNuevos.join(', ')}` : '') + `\n` +
      `Días de Zoho no legibles: ${diasFallidos} de ${diasTotal}\n` +
      new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })
    ).catch(() => {});
  }

  return stats;
}

function startReconciliacionCitasJob() {
  const activo = process.env.RECONCILIACION_CITAS === 'on';
  console.log(`Reconciliación de citas: ${activo ? 'ACTIVA' : 'inactiva (RECONCILIACION_CITAS != "on")'}`);
  if (!activo) return; // ship dark — se enciende a propósito cuando esté listo

  // node-cron's fixed wall-clock schedules (p.ej. */30 * * * *) disparan en :00
  // y :30 sin importar cuándo arrancó el proceso, así que un deploy a las :01
  // esperaría 29 minutos para la primera pasada de un job cuyo propósito entero
  // es atajar pérdidas de ráfagas masivas lo antes posible. setTimeout+setInterval
  // ata la cadencia al boot en cambio, así la primera pasada es predecible.
  setTimeout(() => {
    runReconciliacionCitasJob().catch(err => console.error('[reconciliacionCitasJob] Unhandled error:', err.message));
    setInterval(() => {
      runReconciliacionCitasJob().catch(err => console.error('[reconciliacionCitasJob] Unhandled error:', err.message));
    }, INTERVALO_MS);
  }, PRIMERA_PASADA_MS);
}

module.exports = { startReconciliacionCitasJob, runReconciliacionCitasJob };
