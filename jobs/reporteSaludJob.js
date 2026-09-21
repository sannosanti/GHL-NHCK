'use strict';

const cron = require('node-cron');
const db = require('../db');
const { pool } = require('../db');
const { env } = require('../config');
const ghl = require('../services/ghl');
const zoho = require('../services/zoho');
const { notify, notifyError } = require('../services/notifier');
const { refZoho } = require('../webhooks/zoho');

// Every failure this system had in production was found by a person staring at
// a screen, never by the system itself: the 24h reminder reached 3 of 38
// appointments for two months, 65 of 348 Zoho appointments never reached the
// CRM, a patient got 4 confirmations with different dates inside 90 seconds,
// and two bots answered the same thread six seconds apart. Every one of them
// was reported as a SYMPTOM by whoever tripped over it, weeks or months late,
// because the system had no way to say "I am failing".
//
// This job is that voice. It measures the six failures that already happened,
// once a day, and posts a single message to Cliq.
//
// Two rules follow from why it exists, and both are the OPPOSITE of
// reconciliacionCitasJob's "stay quiet when there is nothing to report":
//
//   1. It ALWAYS sends, even when every number is healthy. The message is a
//      heartbeat: a morning with no report is itself the alert that the
//      monitor died.
//   2. It never prints "0" for something it could not measure. Confusing those
//      two is exactly the bug that hid the 65 lost appointments — a silent
//      failure reads as a healthy zero. Each metric fails in isolation and says
//      "no se pudo medir" on its own line; a broken metric never takes the
//      other five down with it.
//
// It is deliberately NOT merged into dailyReport.js: that job is a commercial
// funnel summary (how many paid, how many escalated) scoped to this agent's own
// conversations, sent at 9pm to whoever reads sales numbers. This one is an
// infrastructure health check over the whole shared GHL location, sent at 7am
// so a broken night is visible before the first patient of the day. Mixing them
// would bury a red signal inside a sales report, and a failure in either half
// would silence the other.

// ─── VENTANA Y ZONA HORARIA ───────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

// Colombia es UTC-5 todo el año (no tiene horario de verano), así que el inicio
// de un día local es ese día a las 00:00 con offset fijo -05:00. No hace falta
// librería de zonas horarias ni lógica de calendario.
function bogotaDateISO(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * DAY_MS)
    .toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // YYYY-MM-DD
}

function bogotaDayStart(offsetDays = 0) {
  return new Date(`${bogotaDateISO(offsetDays)}T00:00:00-05:00`).getTime();
}

// ─── PRESUPUESTO DE LLAMADAS A LA API ─────────────────────────────────────────
// Corre una sola vez al día, así que puede gastar decenas de llamadas donde un
// job que corre cada 30 minutos no podría. El techo por corrida es:
//   1  lista de calendarios
//   + N eventos de hoy (una por calendario; hoy la location tiene ~19)
//   + 1  página de conversaciones
//   + MAX_CONVERSATIONS_WITH_MESSAGES  mensajes para ráfagas y bots duplicados
//   + hasta 2 por contacto con cita de hoy que no aparezca en esa página
//   + ZOHO_DAYS_AHEAD  llamadas a Zoho Creator
// ≈ 200 en el peor caso. En la práctica bastante menos: los mensajes de una
// conversación se leen UNA vez y los comparten las métricas 1, 4 y 5.

const ZOHO_DAYS_AHEAD = 21;                  // la auditoría que encontró 65 de 348 miró 21 días
const MAX_CONVERSATIONS = 100;               // tope de la API en una sola llamada
const MAX_CONVERSATIONS_WITH_MESSAGES = 60;  // cuántas de esas se abren para leer mensajes
const MESSAGES_PER_CONVERSATION = 100;       // ~2 días de un hilo activo: cubre la ventana de 24 h
const MAX_REMINDER_CONTACTS = 60;            // contactos con cita de hoy que se revisan uno a uno

// ─── LÍMITES DE TIEMPO ────────────────────────────────────────────────────────
// No hay UN solo timeout HTTP en todo el repo: ni fetchGHL, ni el fetch de Zoho,
// ni el pool de Postgres. Un socket con TLS abierto que se queda mudo (un
// balanceador que descarta el flujo sin RST, un NAT que se come el FIN) no se
// resuelve nunca, y sin timeout la promesa no se asienta JAMÁS. Sin estos
// límites, una sola llamada colgada dejaba `finally` sin correr, la bandera de
// corrida arriba, y el reporte no volvía a salir nunca más — sólo un redeploy lo
// recuperaba. El modo de falla que produce ese silencio es el cuelgue del propio
// monitor, que es la última cosa que alguien va a ir a mirar.
//
// El latido es el producto entero de este job: vale mil veces más una métrica
// que dice "tardó demasiado" que un silencio permanente que nadie interpreta.
const GHL_TIMEOUT_MS = 20 * 1000;        // por llamada HTTP a GHL
const METRIC_TIMEOUT_MS = 6 * 60 * 1000; // por métrica completa (la 1 hace hasta ~140 llamadas)
const NOTIFY_TIMEOUT_MS = 30 * 1000;     // el POST a Cliq tampoco tiene timeout propio
const DB_TIMEOUT_MS = 60 * 1000;         // el pool no tiene statement_timeout
// Techo del candado entre corridas. Los deadlines por métrica ya acotan una
// corrida a ~36 min; esto es la red por si algo queda sin acotar.
const MAX_RUN_MS = 60 * 60 * 1000;

// ─── UMBRALES ─────────────────────────────────────────────────────────────────

// Una cita sin recordatorio es un paciente que puede no aparecer, así que el
// umbral es alto a propósito: por debajo de esto el envío está roto, no lento.
const REMINDER_COVERAGE_ALERT = 0.9;

// No es GHL quien define esto: es nuestro. Un mensaje de paciente sin abrir
// puede ser normal a los 5 minutos; a la media hora ya es alguien esperando.
const UNREAD_ALERT_MINUTES = 30;

const BURST_WINDOW_MS = 10 * 60 * 1000;   // "más de 2 confirmaciones en 10 minutos"
const BURST_MIN_MESSAGES = 3;
const DUPLICATE_WINDOW_MS = 90 * 1000;    // dos bots contestando el mismo hilo
const DUPLICATE_MIN_LENGTH = 45;          // más corto que esto son acuses, no respuestas
const DUPLICATE_MIN_JACCARD = 0.40;
const TOKEN_MIN_LENGTH = 3;               // se comparan palabras de MÁS de 3 letras

// Estas cuatro expresiones se validaron a mano contra los mensajes reales de
// esta semana y los números del reporte dependen de ellas — cambiarlas cambia
// lo que el reporte significa.
//
// TEMPLATE_RE es la más delicada: sin excluir las plantillas, el detector de
// bots duplicados devolvía 59 pares, de los cuales 56 eran dos plantillas
// parecidas enviadas a tiempo (ruido puro). Con la exclusión quedan los 3 pares
// reales. El filtro NO es cosmético: es lo que separa la señal del ruido.
const REMINDER_RE = /te recordamos tu cita/i;
const CONFIRMATION_RE = /quedó agendada/i;
const TEMPLATE_RE = /quedó agendada|te recordamos tu cita|únicamente para el envío de recordatorios|un gusto saludarte/i;

// El bot calla a propósito en un hilo escalado: ahí el "sin leer" es la persona
// que atiende, no una falla del sistema. Se cuenta aparte, no se suma al rojo.
const ESCALATED_RE = /escalado/i;

const SNAPSHOT_EVENT = 'reporte_salud';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_HEADERS = { 'Authorization': `Bearer ${env.ghlKey}`, 'Version': '2021-04-15' };

// setInterval/cron no esperan a que termine el callback async. Una corrida que
// se cuelga en una llamada sin timeout no debe solaparse con la del día
// siguiente y duplicar el reporte y el gasto de API.
//
// Guarda el INICIO y un token en vez de un booleano: con un booleano, una
// corrida que nunca se asienta dejaba el candado puesto para siempre y el job
// quedaba mudo hasta el próximo redeploy. El token evita que una corrida
// zombi que despierta tarde le libere el candado a la que está corriendo ahora.
let corridaActual = null; // { inicio: number, token: object }

// ─── LECTURA DE GHL ───────────────────────────────────────────────────────────
// Se usa fetchGHL y no fetch directo porque es el único wrapper que drena el
// cuerpo de la respuesta y reintenta: sin eso, un socket keep-alive degradado
// aparece como "Premature close" en una llamada posterior no relacionada.
//
// A diferencia de ghl.getConversationId y ghl.getConversationMessages, estos
// helpers LANZAN cuando GHL falla en vez de devolver null o []. Esa diferencia
// es todo el punto del job: un error de red que se traduce a "lista vacía" se
// leería como "no se envió ningún recordatorio", que es justo la confusión
// entre cero y no-medido que este reporte existe para evitar.
async function ghlGet(path) {
  // node-fetch v2 tiene timeout: 0 por defecto — sin esto, una respuesta que
  // nunca llega se espera para siempre. fetchGHL reenvía las opciones a fetch,
  // y su reintento arranca un timeout nuevo, así que no hay señal reusada.
  const { res, data } = await ghl.fetchGHL(`${GHL_BASE}${path}`, {
    headers: GHL_HEADERS,
    timeout: GHL_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`GHL ${path.split('?')[0]} respondió HTTP ${res.status}`);
  return data || {};
}

// ghlGet LANZA cuando GHL falla, pero un 200 con el cuerpo cambiado no es un
// fallo para fetch: `{conversations: null}`, una clave renombrada o una
// respuesta anidada distinta pasaban derecho y se degradaban a []. Y [] es
// truthy, así que el job seguía como si la lista estuviera vacía de verdad y
// tres métricas imprimían ceros sanos. Ese endpoint YA nos quemó antes (ver el
// comentario de services/ghl.js sobre `conversations` ausente). Una forma que
// no reconocemos es un fallo de lectura, no una lista vacía.
function requireArray(value, queEs) {
  if (!Array.isArray(value)) throw new Error(`GHL no devolvió ${queEs} en el formato esperado`);
  return value;
}

async function listCalendars() {
  const data = await ghlGet(`/calendars/?locationId=${env.ghlLocationId}`);
  return requireArray(data.calendars, 'la lista de calendarios');
}

async function listCalendarEvents(calendarId, startMs, endMs) {
  const data = await ghlGet(
    `/calendars/events?locationId=${env.ghlLocationId}&calendarId=${calendarId}&startTime=${startMs}&endTime=${endMs}`
  );
  // Acá el vacío SÍ es legítimo: una agenda sin citas hoy. Sólo se rechaza la
  // forma que no es lista.
  return requireArray(data.events, 'los eventos del calendario');
}

async function searchConversations() {
  const data = await ghlGet(
    `/conversations/search?locationId=${env.ghlLocationId}&limit=${MAX_CONVERSATIONS}&sortBy=last_message_date&sort=desc`
  );
  return requireArray(data.conversations, 'la lista de conversaciones');
}

async function findConversationId(contactId) {
  const data = await ghlGet(`/conversations/search?locationId=${env.ghlLocationId}&contactId=${contactId}`);
  return data?.conversations?.[0]?.id || null;
}

// La respuesta llega como {messages:{messages:[...]}} en unos endpoints y como
// {messages:[...]} en otros — las dos formas son reales en esta cuenta.
async function fetchMessages(conversationId) {
  const data = await ghlGet(`/conversations/${conversationId}/messages?limit=${MESSAGES_PER_CONVERSATION}`);
  const messages = data?.messages?.messages || data?.messages || [];
  return Array.isArray(messages) ? messages : [];
}

// Las métricas 1, 4 y 5 miran las mismas conversaciones. El caché vive UNA
// corrida (se crea dentro de runReporteSalud) para no arrastrar mensajes viejos
// al reporte del día siguiente.
async function getMessages(ctx, conversationId) {
  if (ctx.messages.has(conversationId)) return ctx.messages.get(conversationId);
  const messages = await fetchMessages(conversationId);
  ctx.messages.set(conversationId, messages);
  return messages;
}

// ─── UTILIDADES DE MEDICIÓN ───────────────────────────────────────────────────

// GHL devuelve fechas como ISO en unos campos y como epoch en otros, y algunos
// epoch vienen en segundos. Un epoch en segundos tratado como milisegundos cae
// en 1970 y la comparación de ventana da siempre falso, en silencio.
function toMillis(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function withinWindow(value, startMs, endMs) {
  const ms = toMillis(value);
  return Number.isFinite(ms) && ms >= startMs && ms < endMs;
}

function outboundInWindow(messages, startMs, endMs) {
  return messages
    .filter(m => m.direction === 'outbound' && withinWindow(m.dateAdded, startMs, endMs))
    .sort((a, b) => toMillis(a.dateAdded) - toMillis(b.dateAdded));
}

// Jaccard sobre palabras largas, sin acentos ni signos: dos respuestas escritas
// por dos bots distintos al mismo hilo dicen lo mismo con otras palabras, así
// que comparar el texto literal no las encuentra (y si son idénticas es un
// reenvío, que es otra cosa y no cuenta).
function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > TOKEN_MIN_LENGTH)
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

// Devuelve la referencia CRUDA, no un texto ya resuelto: el nombre bueno vive en
// contact_cache y se resuelve para todo el mensaje de una sola vez, al final.
function conversationRef(conversation) {
  const nombre = String(conversation?.contactName || conversation?.fullName || '').trim();
  return { contactId: conversation?.contactId || null, nombre: nombre || null };
}

// Los títulos de GHL los arma tituloGHL como "Cita - Juan Pérez" (tipo primero).
// Sirven de respaldo cuando contact_cache no tiene el contacto, pero el prefijo
// del tipo es ruido en una lista de nombres.
function nameFromTitle(title) {
  const texto = String(title || '').trim();
  if (!texto) return null;
  const partes = texto.split(' - ');
  const nombre = (partes.length > 1 ? partes.slice(1).join(' - ') : texto).trim();
  return nombre || null;
}

function eventHour(event) {
  const ms = toMillis(event?.startTime);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
  });
}

// El mensaje lo lee alguien que tiene que ACTUAR esa misma mañana. Un contactId
// de GHL ("qT8xL2pR9vKm3nB7") no sirve para llamar a nadie. contact_cache ya
// guarda el nombre real, así que se resuelve en UNA consulta para todos los
// contactos que van a salir en el mensaje — el mismo camino que ya usa
// dailyReport. Si la consulta falla, el reporte sale igual con IDs cortos: un
// nombre faltante no puede costar el latido.
async function loadContactNames(contactIds) {
  const nombres = new Map();
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (ids.length === 0) return nombres;
  try {
    const { rows } = await conDeadline(
      pool.query(
        'SELECT contact_id, contact_data FROM contact_cache WHERE contact_id = ANY($1::text[])',
        [ids]
      ),
      DB_TIMEOUT_MS,
      'nombres de contacto'
    );
    for (const row of rows) {
      let data = row.contact_data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
      const nombre = [data?.firstName, data?.lastName].filter(Boolean).join(' ').trim()
        || String(data?.name || data?.contactName || '').trim();
      if (nombre) nombres.set(row.contact_id, nombre);
    }
  } catch (err) {
    console.error('[reporteSaludJob] no se pudieron resolver nombres de contacto:', err.message);
  }
  return nombres;
}

function shortId(contactId) {
  const id = String(contactId || '').trim();
  return id ? `#${id.slice(0, 6)}` : 'sin identificar';
}

// Ni node-fetch hacia Zoho ni el pool de Postgres tienen timeout, así que una
// sola llamada colgada bastaba para que la corrida no terminara nunca. Acá se
// le pone un techo a cada métrica por separado: la que se cuelga dice "tardó
// demasiado" y las otras cinco salen igual. La promesa colgada sigue su curso
// en segundo plano y nadie la espera — se prefiere eso a perder el latido.
// El temporizador NO va con unref(): un timer sin referencia no sostiene el
// event loop, así que si el resto del proceso queda ocioso Node sale antes de
// que el deadline dispare y el límite no existe. Se limpia siempre en el
// finally, así que no puede retrasar el apagado más allá del propio deadline.
function conDeadline(promesa, ms, label) {
  let temporizador;
  const limite = new Promise((_, reject) => {
    temporizador = setTimeout(
      () => reject(new Error(`${label}: tardó más de ${Math.round(ms / 1000)} s`)),
      ms
    );
  });
  return Promise.race([Promise.resolve(promesa), limite])
    .finally(() => clearTimeout(temporizador));
}

// El motivo crudo de un error trae host, puerto, nombre de tabla y ruta del
// endpoint: "connect ETIMEDOUT 10.128.0.14:5432", 'relation "citas_sync" does
// not exist'. Quien lee esto atiende pacientes desde el celular y no puede
// hacer NADA con eso; lo que sí hace, en dos semanas, es aprender a saltearse
// las líneas que no entiende — y esa es justo la línea que más importa. El
// texto completo queda en los logs, que es donde pertenece.
function motivoLegible(err) {
  const msg = String(err?.message || err || '');
  if (/timeout|ETIMEDOUT|tardó más de|abort/i.test(msg)) return 'el servicio tardó demasiado en responder';
  if (/HTTP 401|HTTP 403/i.test(msg)) return 'el servicio rechazó las credenciales';
  if (/HTTP 429/i.test(msg)) return 'el servicio nos frenó por exceso de consultas';
  if (/HTTP 4\d\d/i.test(msg)) return 'el servicio rechazó la consulta';
  if (/HTTP 5\d\d/i.test(msg)) return 'el servicio respondió con un error';
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|socket|network|fetch failed|premature/i.test(msg)) {
    return 'no hubo conexión con el servicio';
  }
  if (/relation|column|syntax|pool|database/i.test(msg)) return 'la base de datos no respondió a la consulta';
  if (/formato esperado/i.test(msg)) return 'el servicio respondió con un formato que no reconocemos';
  if (/Zoho/i.test(msg)) return 'Zoho no respondió';
  if (/GHL/i.test(msg)) return 'GHL no respondió como se esperaba';
  return 'el origen de los datos no respondió como se esperaba';
}

// Cada métrica se envuelve acá: si revienta, devuelve "no se pudo medir" con el
// motivo y las otras cinco siguen su camino. Nunca se pierde el reporte entero
// por una métrica rota.
async function safe(label, fn, deadlineMs = METRIC_TIMEOUT_MS) {
  try {
    const value = await conDeadline(fn(), deadlineMs, label);
    return { ok: true, ...value };
  } catch (err) {
    console.error(`[reporteSaludJob] ${label}: no se pudo medir —`, err.message);
    return { ok: false, motivo: err?.message || String(err), motivoCorto: motivoLegible(err) };
  }
}

// ─── MÉTRICA 1: RECORDATORIOS DE 24 HORAS ─────────────────────────────────────
// Para las citas confirmadas de HOY, ¿a cuántas les llegó AYER el recordatorio?
// Medición histórica: 3 de 38 durante dos meses.
async function measureReminders(ctx) {
  const todayStart = bogotaDayStart(0);
  const yesterdayStart = todayStart - DAY_MS;
  const todayEnd = todayStart + DAY_MS;

  const calendars = await listCalendars();
  if (calendars.length === 0) throw new Error('GHL no devolvió ningún calendario');

  const appointments = [];
  let calendarsFailed = 0;
  for (const calendar of calendars) {
    try {
      const events = await listCalendarEvents(calendar.id, todayStart, todayEnd);
      for (const event of events) {
        if (event.appointmentStatus !== 'confirmed') continue;
        if (!event.contactId) continue;
        appointments.push(event);
      }
    } catch (err) {
      // Una agenda ilegible no invalida el resto: se cuenta y se declara en el
      // mensaje, para que nadie lea el porcentaje como si fuera completo.
      calendarsFailed++;
      console.error(`[reporteSaludJob] agenda ${calendar.id} ilegible:`, err.message);
    }
  }
  if (calendarsFailed === calendars.length) {
    throw new Error(`ninguna de las ${calendars.length} agendas de GHL se pudo leer`);
  }

  // Una cita creada HOY nunca pudo recibir el recordatorio de ayer: contarla
  // como fallo dejaría la métrica en rojo permanente por diseño y el rojo
  // dejaría de significar algo. Si dateAdded no se puede leer se cuenta igual,
  // porque el sesgo tiene que caer en contra del sistema, no a su favor.
  const eligible = appointments.filter(event => {
    const created = toMillis(event.dateAdded);
    return Number.isFinite(created) ? created < todayStart : true;
  });
  const skipped = appointments.length - eligible.length;

  const contacts = [...new Set(eligible.map(e => e.contactId))];
  const coverage = new Map(); // contactId -> true | false | null ("no se pudo saber")
  let lookups = 0;
  let cappedContacts = 0;

  for (const contactId of contacts) {
    if (lookups >= MAX_REMINDER_CONTACTS) { coverage.set(contactId, null); cappedContacts++; continue; }
    lookups++;
    try {
      const conversationId = ctx.conversationByContact.get(contactId) || await findConversationId(contactId);
      if (!conversationId) {
        // Sin conversación en GHL no hay por dónde mandar nada: es un fallo
        // real de cobertura, no un dato faltante.
        coverage.set(contactId, false);
        continue;
      }
      const messages = await getMessages(ctx, conversationId);
      coverage.set(contactId, messages.some(m =>
        m.direction === 'outbound' &&
        REMINDER_RE.test(m.body || '') &&
        withinWindow(m.dateAdded, yesterdayStart, todayStart)
      ));
    } catch (err) {
      coverage.set(contactId, null);
      console.error(`[reporteSaludJob] recordatorio de ${contactId} no verificable:`, err.message);
    }
  }

  // Se guardan los NOMBRES, no sólo los conteos. A las 7 de la mañana, con la
  // métrica en rojo y las citas siendo HOY, la única acción posible en las dos
  // horas siguientes es llamar a esos pacientes; un porcentaje no dice a quién.
  // El dato ya estaba acá y se tiraba en el return.
  let covered = 0;
  const missingDetail = [];
  const unknownDetail = [];
  for (const appointment of eligible) {
    const state = coverage.get(appointment.contactId);
    const ref = {
      contactId: appointment.contactId,
      nombre: nameFromTitle(appointment.title),
      hora: eventHour(appointment),
    };
    if (state === true) covered++;
    else if (state === false) missingDetail.push(ref);
    else unknownDetail.push(ref);
  }

  return {
    covered,
    missing: missingDetail.length,
    unknown: unknownDetail.length,
    missingDetail,
    unknownDetail,
    cappedContacts,
    eligible: eligible.length,
    total: appointments.length,
    skipped,
    calendarsFailed,
    calendarsTotal: calendars.length,
  };
}

// ─── MÉTRICA 2: CITAS DE ZOHO QUE NUNCA LLEGARON AL CRM ───────────────────────
// Medición histórica: 65 de 348 en 21 días, invisibles durante meses.
async function measureZohoSync() {
  const ids = [];
  // Paralelo a `ids`, con el nombre y la fecha de cada cita: sin esto el reporte
  // dice CUÁNTAS faltan y nunca CUÁLES, que es la primera pregunta que hace
  // cualquiera la mañana que el número salga en rojo.
  const citasEnVentana = [];
  let daysFailed = 0;
  let sinContacto = 0;

  for (let i = 0; i < ZOHO_DAYS_AHEAD; i++) {
    const fechaISO = bogotaDateISO(i);
    let citas;
    try {
      // getDisponibilidad LANZA si Zoho falla en vez de devolver []: por eso un
      // día ilegible se cuenta como ilegible y no como "día sin citas".
      citas = await zoho.getDisponibilidad(fechaISO);
    } catch (err) {
      daysFailed++;
      console.error(`[reporteSaludJob] Zoho ilegible para ${fechaISO}:`, err.message);
      continue;
    }
    for (const cita of citas) {
      if (cita.Tipo === 'Bloqueo') continue;      // un bloqueo no es un paciente
      if (!cita.ID) continue;
      if (!refZoho(cita.Contacto)) {
        // Descartar esto en silencio es lo que hacía que un renombre del campo
        // Contacto vaciara la ventana entera y el reporte dijera "0 de 0" en
        // verde. Se cuenta para poder declararlo.
        sinContacto++;
        continue;
      }
      ids.push(cita.ID);
      citasEnVentana.push({
        id: cita.ID,
        nombre: String(cita.Contacto?.display_value || '').trim() || null,
        fecha: fechaISO,
      });
    }
  }

  if (daysFailed === ZOHO_DAYS_AHEAD) {
    throw new Error(`Zoho no respondió para ninguno de los ${ZOHO_DAYS_AHEAD} días`);
  }

  // Una sola consulta en vez de un getCitaSync por cita: con ~350 citas en la
  // ventana, la versión fila por fila son 350 viajes a la base para responder
  // una pregunta que el motor contesta de una.
  const { rows } = await conDeadline(
    pool.query(
      `SELECT zoho_cita_id FROM citas_sync
        WHERE zoho_cita_id = ANY($1::text[]) AND ghl_event_id IS NOT NULL`,
      [ids]
    ),
    DB_TIMEOUT_MS,
    'citas sincronizadas'
  );
  const synced = new Set(rows.map(r => r.zoho_cita_id));
  const missingDetail = citasEnVentana.filter(c => !synced.has(c.id));

  return {
    total: ids.length,
    missing: missingDetail.length,
    missingDetail,
    daysFailed,
    sinContacto,
  };
}

// ─── MÉTRICA 3: MENSAJES DE PACIENTES SIN LEER ────────────────────────────────
// Histórico: 7 de 100 sin leer, y 6 de esas 7 estaban escaladas — el bot calla
// a propósito ahí. Contarlas juntas convertiría lo normal en alarma diaria.
function measureUnread(conversations, now) {
  let pending = 0, escalated = 0, oldestMs = 0;
  let sinEdad = 0, edadAproximada = 0;

  for (const conversation of conversations) {
    if (!(Number(conversation.unreadCount) > 0)) continue;
    const tags = Array.isArray(conversation.tags) ? conversation.tags : [];
    if (tags.some(tag => ESCALATED_RE.test(String(tag)))) { escalated++; continue; }
    pending++;

    // firstUnreadInboundTimestamp NO está en la lista de campos verificados de
    // /conversations/search. Si GHL lo renombra o lo deja de mandar, toMillis
    // devuelve NaN — y tratarlo como 0 minutos dejaba `0 > 30` en false, o sea
    // VERDE para siempre, con pacientes envejeciendo contra el SLA y sin una
    // sola marca de que no se pudo medir. Un cero no medido se imprimía
    // idéntico a un cero real: la confusión que este job existe para matar,
    // invertida además contra la regla que la métrica 1 sí respeta (el sesgo
    // cae en contra del sistema, no a su favor).
    let since = toMillis(conversation.firstUnreadInboundTimestamp);
    let aproximada = false;
    if (!Number.isFinite(since) || since > now) {
      // lastMessageDate sí está verificado y el barrido ya depende de él. En un
      // hilo sin leer el último mensaje suele SER el del paciente, así que
      // sirve de cota. Se marca aproximada porque si el bot contestó después,
      // subestima la espera — y una cota que subestima no puede pasar por
      // medición exacta.
      since = toMillis(conversation.lastMessageDate);
      aproximada = true;
    }

    if (Number.isFinite(since) && since <= now) {
      oldestMs = Math.max(oldestMs, now - since);
      if (aproximada) edadAproximada++;
    } else {
      sinEdad++;
    }
  }

  return {
    pending,
    escalated,
    sinEdad,
    edadAproximada,
    oldestMinutes: Math.round(oldestMs / 60000),
    scanned: conversations.length,
  };
}

// ─── MÉTRICA 4: RÁFAGAS DE CONFIRMACIÓN ───────────────────────────────────────
// Un paciente recibió 4 confirmaciones con fechas distintas en 90 segundos: no
// sabe a cuál hacerle caso, y ninguna alerta existía para eso.
function measureConfirmationBursts(scan) {
  const affected = [];

  for (const { conversation, messages } of scan.byConversation.values()) {
    const confirmations = outboundInWindow(messages, scan.windowStart, scan.windowEnd)
      .filter(m => CONFIRMATION_RE.test(m.body || ''));
    if (confirmations.length < BURST_MIN_MESSAGES) continue;

    // Ventana deslizante: el disparo es "3 o más dentro de 10 minutos", no "3 o
    // más en el día" — un paciente que reprograma dos veces en la tarde es
    // normal, tres confirmaciones en el mismo minuto no.
    let worst = 0;
    for (let i = 0; i < confirmations.length; i++) {
      let count = 0;
      const start = toMillis(confirmations[i].dateAdded);
      for (let j = i; j < confirmations.length; j++) {
        if (toMillis(confirmations[j].dateAdded) - start > BURST_WINDOW_MS) break;
        count++;
      }
      worst = Math.max(worst, count);
    }
    if (worst >= BURST_MIN_MESSAGES) affected.push({ ...conversationRef(conversation), mensajes: worst });
  }

  return { contacts: affected.length, detail: affected, ...scanCoverage(scan) };
}

// ─── MÉTRICA 5: DOS BOTS CONTESTANDO EL MISMO HILO ────────────────────────────
// Evidencia real: dos saludos distintos con 6 segundos de diferencia, uno
// firmando "Soy Carolina". Dos despliegues comparten la location de GHL, así
// que el hilo puede quedar atendido dos veces sin que ninguno de los dos lo sepa.
function measureDuplicateBots(scan) {
  const affected = [];

  for (const { conversation, messages } of scan.byConversation.values()) {
    const outbound = outboundInWindow(messages, scan.windowStart, scan.windowEnd)
      .filter(m => (m.body || '').trim().length > DUPLICATE_MIN_LENGTH)
      .filter(m => !TEMPLATE_RE.test(m.body || ''));  // sin esto el resultado es 95% ruido

    let pairs = 0;
    for (let i = 0; i < outbound.length; i++) {
      const a = outbound[i];
      const aTime = toMillis(a.dateAdded);
      const aTokens = tokenize(a.body);
      for (let j = i + 1; j < outbound.length; j++) {
        const b = outbound[j];
        if (toMillis(b.dateAdded) - aTime > DUPLICATE_WINDOW_MS) break; // vienen ordenados
        // Idénticos = reenvío del mismo mensaje, que es otro problema y no este.
        if ((a.body || '').trim() === (b.body || '').trim()) continue;
        if (jaccard(aTokens, tokenize(b.body)) >= DUPLICATE_MIN_JACCARD) pairs++;
      }
    }
    if (pairs > 0) affected.push({ ...conversationRef(conversation), pares: pairs });
  }

  return {
    pairs: affected.reduce((total, a) => total + a.pares, 0),
    conversations: affected.length,
    detail: affected,
    ...scanCoverage(scan),
  };
}

// ─── MÉTRICA 6: CITAS PERDIDAS YA REGISTRADAS ─────────────────────────────────
// El webhook de Zoho registra 'cita_zoho_no_sincronizada' cuando una cita no
// llega a GHL. Ese registro ya existe; lo que faltaba era que alguien lo mirara.
//
// A propósito SIN filtrar por agent: la sincronización Zoho -> GHL es compartida
// por los dos despliegues sobre la misma location, así que filtrar por agente
// escondería la mitad de las pérdidas — que es la clase de recorte silencioso
// que este reporte existe para eliminar.
async function measureLoggedLostAppointments() {
  const { rows } = await conDeadline(
    pool.query(
      `SELECT COUNT(*)::int AS total FROM transaction_logs
        WHERE event_type = 'cita_zoho_no_sincronizada'
          AND created_at > NOW() - INTERVAL '24 hours'`
    ),
    DB_TIMEOUT_MS,
    'citas perdidas registradas'
  );
  return { count: rows[0]?.total ?? 0 };
}

// ─── BARRIDO COMPARTIDO DE CONVERSACIONES ─────────────────────────────────────
// Las métricas 4 y 5 leen los mismos mensajes, así que se leen una sola vez.
async function scanRecentConversations(ctx, conversations) {
  const windowEnd = Date.now();
  const windowStart = windowEnd - DAY_MS;
  const byConversation = new Map();
  let failed = 0;

  // La lista viene ordenada por last_message_date descendente, así que las
  // primeras son las únicas que pueden tener actividad en la ventana de 24 h.
  const conActividad = conversations.filter(c => {
    const last = toMillis(c.lastMessageDate);
    return !Number.isFinite(last) || last >= windowStart; // sin fecha legible, se revisa igual
  });
  const candidates = conActividad.slice(0, MAX_CONVERSATIONS_WITH_MESSAGES);

  for (const conversation of candidates) {
    if (!conversation.id) continue;
    try {
      byConversation.set(conversation.id, {
        conversation,
        messages: await getMessages(ctx, conversation.id),
      });
    } catch (err) {
      failed++;
      console.error(`[reporteSaludJob] mensajes de ${conversation.id} ilegibles:`, err.message);
    }
  }

  if (candidates.length > 0 && failed === candidates.length) {
    throw new Error(`no se pudo leer ninguna de las ${candidates.length} conversaciones`);
  }

  return {
    byConversation,
    candidatas: candidates.length,
    leidas: byConversation.size,
    failed,
    // El día de más volumen es el día que más se cae la cobertura: con más de
    // MAX_CONVERSATIONS_WITH_MESSAGES conversaciones activas, el resto no se
    // mira. Callarlo hacía que un 🟢 0 sobre el 60% del tráfico se leyera igual
    // que un 🟢 0 sobre el 100%.
    sinRevisar: conActividad.length - candidates.length,
    windowStart,
    windowEnd,
  };
}

// scanRecentConversations sabía cuántas conversaciones pudo leer y cuántas no, y
// ese dato moría acá: measureConfirmationBursts y measureDuplicateBots no lo
// devolvían y buildMessage nunca lo veía. Con 59 de 60 conversaciones ilegibles
// (rate-limit de GHL a mitad del barrido, lo más común con ~60 llamadas
// seguidas) la guarda de "fallaron TODAS" no dispara, y las dos métricas
// publicaban un cero limpio estando ciegas. El autor ya había establecido el
// patrón "declará lo que no pudiste leer" en las métricas 1 y 2 — acá faltaba.
function scanCoverage(scan) {
  return {
    leidas: scan.leidas,
    candidatas: scan.candidatas,
    failed: scan.failed,
    sinRevisar: scan.sinRevisar,
  };
}

// ─── COMPARACIÓN CONTRA EL DÍA ANTERIOR ───────────────────────────────────────
// El reporte se guarda como una fila más de transaction_logs. Un número suelto
// no dice si algo está empeorando; "65, ayer 60" sí. Se persiste acá en vez de
// en una tabla nueva porque el histórico queda consultable con el mismo SQL que
// ya usa todo el resto.
async function readPreviousSnapshot() {
  // La edad se calcula en SQL y no restando created_at en JS: esa columna es
  // TIMESTAMP WITHOUT TIME ZONE y pg la interpreta con la zona local del
  // proceso Node, así que un desfase entre Postgres y Node corre la edad horas
  // enteras y el reporte diría "ayer" sobre una corrida de hace dos días.
  const { rows } = await conDeadline(
    pool.query(
      `SELECT data, EXTRACT(EPOCH FROM (NOW() - created_at)) AS edad_segundos
         FROM transaction_logs
        WHERE event_type = $1 AND agent = $2
        ORDER BY created_at DESC LIMIT 1`,
      [SNAPSHOT_EVENT, env.agentName]
    ),
    DB_TIMEOUT_MS,
    'reporte anterior'
  );
  if (!rows[0]) return null;

  let data = rows[0].data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  if (!data) return null;

  const hours = Number(rows[0].edad_segundos) / 3600;
  // "ayer" sólo si de verdad es de ayer. Una corrida a mano hace dos horas no
  // es una tendencia, y etiquetarla como ayer haría mentir al reporte.
  const label = hours >= 18 && hours <= 36 ? 'ayer' : `hace ${Math.round(hours)} h`;
  return { data, label };
}

function deltaText(current, previous, label) {
  if (!label || !Number.isFinite(previous)) return '';
  if (previous === current) return ` — igual que ${label}`;
  return ` — ${label} ${previous}`;
}

// Comparar conteos crudos INVIERTE la tendencia cuando el denominador cambia:
// ayer 12 de 13 (92%, sano), hoy 14 de 60 (23%, roto), y "— ayer 12" se lee como
// una mejora de +2 justo el día que el envío se cayó. El denominador de ayer ya
// estaba guardado en el snapshot y nunca se leía. La línea afirma un porcentaje,
// así que la tendencia tiene que comparar ese porcentaje.
// Se muestra "ayer 12 de 13" y no "ayer 92%": el porcentaje redondeado esconde
// los cambios chicos (1 de 340 y 0 de 348 caen los dos en 0%) y el par
// completo se lee igual de rápido en el celular sin perder nada.
function deltaRatioText(part, total, prevPart, prevTotal, label) {
  if (!label) return '';
  if (!Number.isFinite(prevPart) || !Number.isFinite(prevTotal)) return '';
  if (prevTotal <= 0 || total <= 0) return '';
  if (prevPart === part && prevTotal === total) return ` — igual que ${label}`;
  return ` — ${label} ${prevPart} de ${prevTotal}`;
}

// ─── ARMADO DEL MENSAJE ───────────────────────────────────────────────────────
// Lo lee alguien no técnico desde el celular: número grande primero, una línea
// por métrica, y el estado visible sin leer el texto. Nada de volcar JSON.

const OK = '🟢';
const BAD = '🔴';
const PARTIAL = '🟡';
const UNKNOWN = '⚪';

// El contador `blind` sólo subía cuando una métrica fallaba ENTERA. La ceguera
// PARCIAL — 18 de 19 agendas ilegibles, 59 de 60 conversaciones caídas, 20 de 38
// recordatorios sin verificar — no tenía ninguna representación: ni en el ícono
// ni en el resumen. En el celular se lee el emoji y el titular, así que un 🟢
// sobre el 5% de la agenda del día se ve idéntico a un 🟢 sobre el 100%.
// Amarillo significa exactamente eso: se midió algo, pero no todo.
function iconFor(bad, parcial) {
  return bad ? BAD : parcial ? PARTIAL : OK;
}

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

// Una sub-línea sangrada en vez de un tercer `·` al final: en pantalla de
// celular la línea ya venía cortada antes de llegar a la parte accionable.
function line(icon, title, text, notas = []) {
  const extra = notas.filter(Boolean).map(n => `\n    ↳ ${n}`).join('');
  return `${icon} *${title}:* ${text}${extra}`;
}

function unmeasured(title, metric) {
  // metric.motivo (crudo, con host/tabla/endpoint) queda en los logs; acá va la
  // versión que le sirve a quien lee.
  return line(UNKNOWN, title, `no se pudo medir — ${metric.motivoCorto || motivoLegible(metric.motivo)}`);
}

function displayName(nombres, entry) {
  return nombres.get(entry?.contactId) || entry?.nombre || shortId(entry?.contactId);
}

// "¿y las otras citas qué pasó con ellas?" es la primera pregunta que hace
// cualquiera la mañana que un número sale en rojo, y con conteos pelados es
// imposible de contestar. Estas listas son la respuesta.
function nameList(detail, nombres, render, max = 5) {
  if (!detail || detail.length === 0) return '';
  const shown = detail.slice(0, max).map(d => render(d, displayName(nombres, d))).join(', ');
  return detail.length > max ? `${shown} y ${detail.length - max} más` : shown;
}

// Nota fija de cobertura del barrido: declara SIEMPRE el tamaño de la muestra.
// Un 🟢 0 salido de una muestra de cero (domingo sin actividad) o de una muestra
// truncada (día cargado, 100 activas, se miran 60) se imprimía idéntico a un 🟢
// 0 salido de una muestra completa.
function scanNote(m) {
  if (m.candidatas === 0) {
    return { parcial: true, nota: 'sin conversaciones activas en 24 h: no hubo nada que revisar' };
  }
  const partes = [`se revisaron ${m.leidas} de ${m.candidatas} conversaciones activas`];
  if (m.failed) partes.push(`${m.failed} ilegibles`);
  if (m.sinRevisar) partes.push(`${m.sinRevisar} fuera por el tope de ${MAX_CONVERSATIONS_WITH_MESSAGES}`);
  return {
    parcial: m.failed > 0 || m.sinRevisar > 0 || m.leidas < m.candidatas,
    nota: partes.join(' · '),
  };
}

function buildMessage(metrics, previous, nombres = new Map()) {
  const label = previous?.label;
  const prev = previous?.data || {};
  const lines = [];
  let red = 0, parcial = 0, blind = 0;

  // Cada métrica declara su propio estado acá y el resumen se arma con eso: un
  // ícono no puede decir "bien" por una medición que no se completó.
  const push = (bad, esParcial, ...args) => {
    if (bad) red++; else if (esParcial) parcial++;
    lines.push(line(iconFor(bad, esParcial), ...args));
  };

  // 1 — Recordatorios
  if (!metrics.reminders.ok) {
    blind++; lines.push(unmeasured('Recordatorios 24 h', metrics.reminders));
  } else {
    const r = metrics.reminders;
    // El denominador honesto es lo que se pudo VERIFICAR. Meter los `unknown`
    // adentro hacía que una caída de medición (20 de 38 con 429 de GHL) saliera
    // 🔴 "18 de 38 (47%)" y alguien se pusiera a llamar a las 7 am a pacientes
    // que ya estaban avisados. Una caída de medición no es una caída de
    // entrega, y el número grande tiene que decir cuál de las dos es.
    const verificadas = r.covered + r.missing;
    const notas = [];
    if (r.missingDetail?.length) {
      notas.push(`sin recordatorio: ${nameList(r.missingDetail, nombres,
        (d, n) => d.hora ? `${n} (${d.hora})` : n)}`);
    }
    const avisos = [];
    if (r.unknown) {
      avisos.push(r.cappedContacts
        ? `${r.unknown} sin verificar (${r.cappedContacts} por el tope de ${MAX_REMINDER_CONTACTS} contactos)`
        : `${r.unknown} sin poder verificar`);
    }
    if (r.skipped) avisos.push(`${r.skipped} agendadas hoy: el recordatorio de ayer no aplicaba`);
    if (r.calendarsFailed) avisos.push(`${r.calendarsFailed} de ${r.calendarsTotal} agendas ilegibles`);
    if (avisos.length) notas.push(avisos.join(' · '));

    const cegueraParcial = r.unknown > 0 || r.calendarsFailed > 0;

    if (r.total === 0) {
      // Antes esta rama también se comía el caso de abajo y afirmaba que no
      // había citas un día que sí las tenía.
      push(false, r.calendarsFailed > 0, 'Recordatorios 24 h', 'sin citas confirmadas para hoy', notas);
    } else if (r.eligible === 0) {
      push(false, r.calendarsFailed > 0, 'Recordatorios 24 h',
        `${r.total} cita(s) confirmada(s) para hoy, todas agendadas hoy mismo`, notas);
    } else if (verificadas === 0) {
      // Todo lo elegible quedó en "no se pudo saber": eso es ceguera, no salud.
      blind++;
      lines.push(line(UNKNOWN, 'Recordatorios 24 h',
        `no se pudo verificar ninguna de las ${r.eligible} citas de hoy`, notas));
    } else {
      const bad = (r.covered / verificadas) < REMINDER_COVERAGE_ALERT;
      const text = `${r.covered} de ${verificadas} citas verificadas (${pct(r.covered, verificadas)}%)`
        + deltaRatioText(r.covered, verificadas, prev.remindersCovered, prev.remindersVerified, label);
      push(bad, cegueraParcial, 'Recordatorios 24 h', text, notas);
    }
  }

  // 2 — Zoho -> CRM
  if (!metrics.zoho.ok) {
    blind++; lines.push(unmeasured('Citas de Zoho en el CRM', metrics.zoho));
  } else {
    const z = metrics.zoho;
    const notas = [];
    if (z.missingDetail?.length) {
      notas.push(`sin llegar: ${nameList(z.missingDetail, nombres,
        (d, n) => d.fecha ? `${n} (${d.fecha})` : n)}`);
    }
    const avisos = [];
    if (z.daysFailed) avisos.push(`${z.daysFailed} de ${ZOHO_DAYS_AHEAD} días de Zoho ilegibles`);
    if (z.sinContacto) avisos.push(`${z.sinContacto} citas sin contacto: no se pueden espejar`);
    if (avisos.length) notas.push(avisos.join(' · '));

    if (z.total === 0) {
      // Una clínica NO tiene cero citas en 21 días. Si el campo Contacto se
      // renombra, el filtro las descarta todas en silencio y esto salía
      // "🟢 0 sin llegar al CRM de 0". Cero citas en la ventana es una anomalía
      // por definición, no una ventana sana.
      push(false, true, 'Citas de Zoho en el CRM',
        `ninguna cita encontrada en los próximos ${ZOHO_DAYS_AHEAD} días — revisar la lectura de Zoho`, notas);
    } else {
      const text = `${z.missing} sin llegar al CRM de ${z.total} (próximos ${ZOHO_DAYS_AHEAD} días)`
        + deltaRatioText(z.missing, z.total, prev.zohoMissing, prev.zohoTotal, label);
      push(z.missing > 0, z.daysFailed > 0, 'Citas de Zoho en el CRM', text, notas);
    }
  }

  // 3 — Sin leer
  if (!metrics.unread.ok) {
    blind++; lines.push(unmeasured('Mensajes sin leer', metrics.unread));
  } else {
    const u = metrics.unread;
    const bad = u.pending > 0 && u.oldestMinutes > UNREAD_ALERT_MINUTES;
    // Si no se pudo medir la antigüedad de NINGUNO de los pendientes, el 0 no
    // es un 0: es un no sé. Nunca más verde por esa vía.
    const edadIncierta = u.pending > 0 && (u.sinEdad > 0 || u.edadAproximada > 0);

    // "de 100 conversaciones" se leía como "las 100 que tiene la clínica", y
    // 100 es simplemente el tope de la página.
    const text = `${u.pending} sin responder de las ${u.scanned} conversaciones más recientes`
      + deltaText(u.pending, prev.unreadPending, label);

    const notas = [];
    if (u.pending > 0) {
      // La cláusula de edad se imprime SIEMPRE que haya pendientes. Antes se
      // escondía cuando oldestMinutes era 0, así que no quedaba ni rastro de
      // que la antigüedad no se había podido medir.
      notas.push(u.sinEdad === u.pending
        ? 'no se pudo medir hace cuánto esperan'
        : `el más viejo hace ${u.oldestMinutes} min`);
    }
    const avisos = [];
    if (u.sinEdad) avisos.push(`${u.sinEdad} sin antigüedad legible`);
    if (u.edadAproximada) avisos.push(`${u.edadAproximada} con antigüedad aproximada`);
    if (u.escalated) avisos.push(`${u.escalated} escalado(s) (el bot calla a propósito)`);
    // Sólo cuando hay algo pendiente: si no, es ruido en una línea sana.
    if (u.pending > 0 && u.scanned >= MAX_CONVERSATIONS) {
      avisos.push(`tope de ${MAX_CONVERSATIONS} por consulta: puede haber más atrás`);
    }
    if (avisos.length) notas.push(avisos.join(' · '));

    push(bad, edadIncierta, 'Mensajes sin leer', text, notas);
  }

  // 4 — Ráfagas de confirmación
  if (!metrics.bursts.ok) {
    blind++; lines.push(unmeasured('Confirmaciones repetidas', metrics.bursts));
  } else {
    const b = metrics.bursts;
    const cobertura = scanNote(b);
    const text = `${b.contacts} paciente(s) con ${BURST_MIN_MESSAGES}+ confirmaciones en 10 min`
      + deltaText(b.contacts, prev.burstContacts, label);
    const notas = [];
    if (b.detail?.length) {
      notas.push(nameList(b.detail, nombres, (d, n) => `${n} (${d.mensajes})`));
    }
    notas.push(cobertura.nota);
    push(b.contacts > 0, cobertura.parcial, 'Confirmaciones repetidas', text, notas);
  }

  // 5 — Bots duplicados
  if (!metrics.duplicates.ok) {
    blind++; lines.push(unmeasured('Dos bots en un hilo', metrics.duplicates));
  } else {
    const d = metrics.duplicates;
    const cobertura = scanNote(d);
    const text = `${d.pairs} respuesta(s) doble(s) en ${d.conversations} hilo(s)`
      + deltaText(d.pairs, prev.duplicatePairs, label);
    const notas = [];
    if (d.detail?.length) notas.push(nameList(d.detail, nombres, (_, n) => n));
    notas.push(cobertura.nota);
    push(d.pairs > 0, cobertura.parcial, 'Dos bots en un hilo', text, notas);
  }

  // 6 — Pérdidas ya registradas
  if (!metrics.lost.ok) {
    blind++; lines.push(unmeasured('Citas perdidas registradas', metrics.lost));
  } else {
    const l = metrics.lost;
    const text = `${l.count} en las últimas 24 h` + deltaText(l.count, prev.lostLogged, label);
    push(l.count > 0, false, 'Citas perdidas registradas', text);
  }

  const fecha = new Date().toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Bogota',
  });
  const hora = new Date().toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
  });

  const partes = [];
  if (red) partes.push(`${red} en rojo`);
  if (parcial) partes.push(`${parcial} a medias`);
  if (blind) partes.push(`${blind} sin medir`);
  const resumen = partes.length === 0 ? 'Todo en orden' : partes.join(', ');

  // El estado va en la PRIMERA línea, no en la segunda. En la lista de chats del
  // celular sólo se ve la primera, y era idéntica todos los días: el día 1 con
  // todo verde y el día 40 con tres en rojo se veían igual. Así es como un
  // reporte diario se vuelve empapelado y deja de leerse.
  return `🩺 *Salud del sistema — ${resumen}*\n_${fecha} · medido ${hora}_\n\n${lines.join('\n')}`;
}

// Sólo números, y null donde no se pudo medir: guardar 0 por una métrica ciega
// haría que mañana el reporte muestre una "mejora" que nunca ocurrió.
function buildSnapshot(metrics) {
  const r = metrics.reminders;
  return {
    remindersCovered: r.ok ? r.covered : null,
    // El denominador que de verdad usa la línea. remindersEligible se seguía
    // guardando sin que nadie lo leyera, y era el dato que faltaba para que la
    // tendencia no mintiera.
    remindersVerified: r.ok ? r.covered + r.missing : null,
    remindersEligible: r.ok ? r.eligible : null,
    zohoMissing: metrics.zoho.ok ? metrics.zoho.missing : null,
    zohoTotal: metrics.zoho.ok ? metrics.zoho.total : null,
    unreadPending: metrics.unread.ok ? metrics.unread.pending : null,
    burstContacts: metrics.bursts.ok ? metrics.bursts.contacts : null,
    duplicatePairs: metrics.duplicates.ok ? metrics.duplicates.pairs : null,
    lostLogged: metrics.lost.ok ? metrics.lost.count : null,
  };
}

// ─── CORRIDA ──────────────────────────────────────────────────────────────────

async function runReporteSalud() {
  if (corridaActual) {
    const minutos = Math.round((Date.now() - corridaActual.inicio) / 60000);
    if (Date.now() - corridaActual.inicio < MAX_RUN_MS) {
      console.log(`[reporteSaludJob] La corrida anterior sigue en curso (${minutos} min) — se salta esta invocación`);
      return null;
    }
    // Un booleano acá dejaba el job mudo PARA SIEMPRE: si una corrida no se
    // asentaba nunca, `finally` no corría y todas las invocaciones siguientes
    // salían por el return de arriba. Y el silencio de este job es
    // indistinguible de una mañana sana, así que nadie se enteraba.
    console.error(`[reporteSaludJob] La corrida anterior lleva ${minutos} min sin terminar — se arranca igual`);
  }

  const token = {};
  corridaActual = { inicio: Date.now(), token };

  try {
    const ctx = { messages: new Map(), conversationByContact: new Map() };
    const previous = await readPreviousSnapshot().catch(err => {
      console.error('[reporteSaludJob] sin comparación con el día anterior:', err.message);
      return null;
    });

    // Una sola llamada alimenta las métricas 3, 4 y 5 y además el índice
    // contacto -> conversación que le ahorra búsquedas a la métrica 1.
    let conversations = null;
    let conversationsError = null;
    try {
      conversations = await conDeadline(searchConversations(), METRIC_TIMEOUT_MS, 'lista de conversaciones');
      for (const c of conversations) {
        if (c.contactId && c.id && !ctx.conversationByContact.has(c.contactId)) {
          ctx.conversationByContact.set(c.contactId, c.id);
        }
      }
    } catch (err) {
      conversationsError = err;
      console.error('[reporteSaludJob] no se pudo listar conversaciones:', err.message);
    }

    const scan = conversations
      ? await safe('barrido de conversaciones', () => scanRecentConversations(ctx, conversations))
      : { ok: false, motivo: `no se pudo listar conversaciones — ${conversationsError.message}` };

    const metrics = {
      reminders: await safe('recordatorios', () => measureReminders(ctx)),
      zoho: await safe('citas de Zoho', () => measureZohoSync()),
      unread: conversations
        ? await safe('mensajes sin leer', async () => measureUnread(conversations, Date.now()))
        : { ok: false, motivo: `no se pudo listar conversaciones — ${conversationsError.message}` },
      bursts: scan.ok
        ? await safe('ráfagas de confirmación', async () => measureConfirmationBursts(scan))
        : { ok: false, motivo: scan.motivo },
      duplicates: scan.ok
        ? await safe('bots duplicados', async () => measureDuplicateBots(scan))
        : { ok: false, motivo: scan.motivo },
      lost: await safe('citas perdidas registradas', () => measureLoggedLostAppointments()),
    };

    // Un solo viaje a contact_cache para todos los contactos que van a salir
    // nombrados en el mensaje. Se hace acá y no dentro de cada métrica para no
    // repetir la consulta cinco veces ni acoplar la medición al render.
    const nombres = await loadContactNames([
      ...(metrics.reminders.missingDetail || []).map(d => d.contactId),
      ...(metrics.reminders.unknownDetail || []).map(d => d.contactId),
      ...(metrics.bursts.detail || []).map(d => d.contactId),
      ...(metrics.duplicates.detail || []).map(d => d.contactId),
    ]);

    const mensaje = buildMessage(metrics, previous, nombres);
    // notify() nunca lanza, pero su fetch tampoco tiene timeout: un Cliq que no
    // contesta colgaba la corrida justo en el último paso.
    const enviado = await conDeadline(notify(mensaje), NOTIFY_TIMEOUT_MS, 'envío a Cliq')
      .catch(err => {
        console.error('[reporteSaludJob] el envío a Cliq no terminó:', err.message);
        return false;
      });
    if (!enviado) {
      // El latido es el producto entero de este job: si no salió, que quede
      // constancia en los logs en vez de una corrida "exitosa" que nadie vio.
      console.error('[reporteSaludJob] EL REPORTE NO SALIÓ A CLIQ:\n' + mensaje);
    }

    await conDeadline(
      db.logEvent(null, null, SNAPSHOT_EVENT, buildSnapshot(metrics)),
      DB_TIMEOUT_MS,
      'guardado del snapshot'
    ).catch(() => {});
    return metrics;
  } finally {
    // En finally y no al final del try: si algo revienta antes del return, el
    // candado tiene que soltarse igual o el job queda trabado para siempre.
    // Se compara el token para que una corrida zombi que despierta tarde no le
    // suelte el candado a la que está corriendo ahora.
    if (corridaActual?.token === token) corridaActual = null;
  }
}

function startReporteSaludJob() {
  // Carolina (NHCK) y Luisa (NHC) son dos despliegues del mismo código sobre la
  // MISMA location de GHL, así que las seis métricas miden exactamente los
  // mismos datos en los dos. Con el job activo en ambos, Cliq recibe dos
  // reportes idénticos cada mañana y se paga el doble de llamadas a la API. Se
  // apaga con REPORTE_SALUD=off en el despliegue gemelo. Va encendido por
  // defecto a propósito: un monitor que hay que acordarse de encender es un
  // monitor apagado, y este job existe justamente porque nadie se acuerda.
  // Se acepta cualquier forma razonable de apagarlo. La comparación exacta con
  // 'off' significaba que OFF, false o 0 no apagaban nada: el gemelo seguía
  // posteando un segundo reporte idéntico cada mañana y duplicando el gasto de
  // API, con la variable puesta y alguien convencido de que lo había apagado.
  const flag = String(process.env.REPORTE_SALUD || '').trim().toLowerCase();
  if (['off', 'false', '0', 'no'].includes(flag)) {
    console.log(`Reporte de salud: inactivo (REPORTE_SALUD=${process.env.REPORTE_SALUD})`);
    return;
  }

  // 12:00 UTC = 7:00 en Colombia, que es UTC-5 todo el año. La hora importa:
  // el reporte tiene que estar leído antes de la primera cita del día.
  cron.schedule('0 12 * * *', () => {
    runReporteSalud().catch(err => {
      console.error('[reporteSaludJob] Error:', err.message);
      // Si la corrida entera se cae, el silencio sería indistinguible de un día
      // sano. Que al menos salga el error por el mismo canal.
      notifyError('reporteSaludJob', err).catch(() => {});
    });
  });
  console.log('Reporte de salud programado (7:00 Colombia) ✓');
}

module.exports = { startReporteSaludJob, runReporteSalud };
