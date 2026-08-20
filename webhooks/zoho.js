'use strict';

const zoho = require('../services/zoho');
const ghl = require('../services/ghl');
const db = require('../db');
const { notify } = require('../services/notifier');

// Una cita que no puede resolver contacto se espeja como bloqueo. El bloqueo
// ocupa el horario, que es lo importante para la agenda, pero no lleva
// contactId: GHL no tiene a quién notificar, así que ese paciente nunca va a
// recibir el recordatorio de su cita.
//
// Hasta ahora eso sólo dejaba un console.error. El 2026-08-12 el cliente
// encontró a mano varias citas convertidas en bloqueo — nadie estaba leyendo los
// logs, y no hay razón para que lo hagan. El aviso convierte un dato roto en
// Zoho (casi siempre un contacto sin Movil) en algo que alguien puede arreglar.
async function avisarDegradacion(motivo, { zohoCitaID, calendarId, inicio, fin, tipo }) {
  console.error(`ZOHO-CITA: ${motivo} — creando como bloqueo`);
  await notify(
    `Cita espejada como bloqueo — sin recordatorio\n` +
    `Motivo: ${motivo}\n` +
    `Cita Zoho: ${zohoCitaID || 'sin ID'}\n` +
    `Horario: ${inicio || '?'} a ${fin || '?'}\n` +
    `Tipo: ${tipo || '?'}\n` +
    `Calendario GHL: ${calendarId}\n\n` +
    `El horario queda ocupado en la agenda, pero el evento no tiene contacto ` +
    `asociado: esa persona no va a recibir recordatorio. Suele resolverse ` +
    `cargando el Movil del contacto en Zoho y reprogramando la cita.\n` +
    new Date().toLocaleString('es-CO')
  ).catch(() => {});
}

// Dedicated GHL calendars for the Zoho -> GHL sync, one per real Zoho
// Consultor/resource — see engram ghl-nhck/sync-zoho-ghl-calendario. Kept
// deliberately separate from the personal calendars already in GHL. Both
// Carolina (NHCK) and Luisa (NHC) share this same Zoho calendar and GHL
// location, so this single webhook covers both brands.
// Zoho Consultor ID -> GHL calendar ID. Ambos lados auditados en vivo el
// 2026-08-04 contra los 19 calendarios de la location, así que el comentario
// nombra el calendario de GHL donde la entrada realmente cae, no el consultor
// del que viene.
//
// El calendario de Juan Esteban Tamayo se llamaba "Pre-evaluación NHC" y se
// renombró el 2026-08-06 porque el cliente lo buscaba por su nombre y no lo
// encontraba. Quedan dos que siguen divergiendo, y a propósito: "Mapeos" y
// "Neurotecnologías" son recursos de Zoho, no personas.
const CALENDARIOS = {
  '3572150000004930155': 'MvnOMgGMs69y6Ewix22r', // Juan Esteban Tamayo
  '3572150000005140253': 'iTdbaauOdCrcNHwsIe2h', // Mapeos -> Neuromapeo NHC
  '3572150000004871148': 'M1fNQqz0yn8LH1op8I4s', // Neurotecnologías
  '3572150000009238003': 'pLhcRJMTzeTjhrv8dqDY', // Katerine Bolivar Uribe
  '3572150000004912180': 'vvb8taavISxlgeGoXd78', // Santiago Gallego (Asesorias y Cursos)
  '3572150000004826082': '5OHWEK3t2Wvg1xc9tsRv', // Yamile Herrera
  '3572150000004871136': 'hsHuxGh5wLknUFxWt0Sk', // Laura Franco Gómez
  '3572150000013136002': 'wRUCuDmqhbxmU3rvgG5j', // Juliana Restrepo Ruiz
  '3572150000004871160': 'kzPKbuB2npt64tyXuFnx', // David Valderrama Goez
  '3572150000006479156': 'SAjr7SxN1h0biqbiprV1', // Juliana Duque Rodriguez
};
// Fallback for entries with no Consultor (Bloqueo/Salida/Entrada/Descanso/
// Almuerzo/Festivo with nobody named) — same reasoning as the
// calcularSlotsLibres fix: a blockless entry still occupies real time and
// must show up somewhere in GHL, not be dropped.
const CALENDAR_GENERAL = 'lzwahRhkogIG1Ct9BX7p';

const MESES_ZOHO = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// Zoho Creator sends an unset lookup as the literal string "null" (or an empty
// string), never as JSON null. Those are truthy in JavaScript, so they sailed
// past `if (!contactoRef)` and reached getContactoPorId('null') — which is what
// produced the misleading "contacto sin celular, contactoID= null" in
// production on 2026-07-30. Normalizes both the object form ({ID, display_value})
// and the bare-string form into an ID, or '' when the field is genuinely empty.
const VALORES_VACIOS = new Set(['', 'null', 'undefined', 'none', '-none-']);

// GHL rejects a calendar title containing a line break with
// `422 Title must be a valid text`, and Zoho's Observaciones is a free-text
// field: it holds pasted Google Meet invitations, payment arrangements, whole
// paragraphs. This only became reachable once the sync started reading the
// record back from Citas_Report — before that Observaciones never arrived and
// every title was a bare "Cita". Found while migrating the historical blocks,
// where 10 of 271 were refused for exactly this.
//
// Flattening whitespace keeps the useful head of the note instead of losing the
// entry, and the cap keeps a pasted invitation from becoming the title.
const LARGO_MAXIMO_TITULO = 100;

function tituloGHL(partes, porDefecto = 'Bloqueo') {
  const texto = partes.filter(Boolean).join(' - ').replace(/\s+/g, ' ').trim();
  if (!texto) return porDefecto;
  return texto.length > LARGO_MAXIMO_TITULO ? `${texto.slice(0, LARGO_MAXIMO_TITULO - 3)}...` : texto;
}

function refZoho(campo) {
  const raw = campo && typeof campo === 'object' ? campo.ID : campo;
  const valor = String(raw ?? '').trim();
  return VALORES_VACIOS.has(valor.toLowerCase()) ? '' : valor;
}

// Zoho Creator datetime strings look like "03-Jul-2026 10:00:00" in Colombia
// local time (UTC-5, no DST). Converts to an ISO string in UTC.
function parseZohoDateTime(str) {
  const m = String(str || '').match(/(\d{2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mmm, yyyy, hh, min, ss] = m;
  const mes = MESES_ZOHO[mmm];
  if (mes === undefined) return null;
  return new Date(Date.UTC(+yyyy, mes, +dd, +hh + 5, +min, +ss)).toISOString();
}

// Los botones de la app de Citas -- Cancelada, No asistió, Ejecutada -- cambian
// el estado en Zoho y hasta ahora GHL no se enteraba: una cita cancelada abajo
// seguía figurando confirmada arriba. Citas_Report no expone el campo Estado, así
// que el estado no se puede deducir; tiene que venir en el aviso.
//
// Cada botón manda su acción y acá se traduce al vocabulario de GHL. Reprogramar
// no está en el mapa porque no es un cambio de estado: llega como un disparo
// normal y lo resuelve propagarCambios moviendo el evento.
const ESTADOS_GHL = {
  'cancelada': 'cancelled',
  'no asistio': 'noshow',
  'no asistió': 'noshow',
  'ejecutada': 'showed',
};

// El aviso de modificación manda el Estado del registro, y la enorme mayoría de
// las ediciones lo dejan en "Programada" — la cita sigue en pie, lo que cambió
// fue el horario. Esos avisos tienen que seguir de largo hasta propagarCambios,
// que es quien detecta la reprogramación.
const ESTADOS_SIN_CAMBIO = new Set(['programada', 'reprogramar', 'reprogramada', 'confirmada']);

/**
 * Aplica en GHL un cambio de estado hecho desde los botones de Zoho.
 * Devuelve true si el disparo era un cambio de estado (haya podido aplicarse o
 * no), para que el handler no siga y lo trate como una cita nueva.
 */
async function aplicarEstado(accionCruda, zohoCitaID) {
  const accion = String(accionCruda || '').trim().toLowerCase();
  if (!accion) return false;
  if (ESTADOS_SIN_CAMBIO.has(accion)) return false;

  const estado = ESTADOS_GHL[accion];
  if (!estado) {
    // Cortar acá dejaba la edición sin procesar: con Estado "Programada" -- que
    // es lo que manda casi toda edición -- la reprogramación nunca llegaba a
    // GHL. Ante un estado que no se reconoce conviene seguir de largo y tratarlo
    // como una edición común: perder un cambio de horario cuesta más que aplicar
    // de más una comparación que probablemente no encuentre diferencias.
    console.error(`ZOHO-CITA: estado "${accionCruda}" no reconocido — se procesa como edición normal`);
    return false;
  }
  if (!zohoCitaID) {
    console.error(`ZOHO-CITA: acción "${accion}" sin ID de registro — no hay cita que actualizar`);
    return true;
  }

  const previo = await db.getCitaSync(zohoCitaID);
  if (!previo?.ghl_event_id) {
    // La cita nunca se espejó, así que no hay nada en GHL que cancelar. Se avisa
    // en vez de callar: significa que el "Replicar" de esa cita no se apretó.
    console.error(`ZOHO-CITA: "${accion}" sobre ${zohoCitaID}, que no está espejada en GHL — nada que actualizar`);
    return true;
  }
  if (previo.clase === 'bloqueo') {
    console.log(`ZOHO-CITA: "${accion}" sobre un bloqueo (${zohoCitaID}) — los bloqueos no tienen estado`);
    return true;
  }

  // El PUT reemplaza en vez de parchear: horario y título se reenvían tal cual o
  // se pierden. Lo único que cambia es el estado.
  const actual = await ghl.getCitaEnCalendario(previo.ghl_event_id);
  await ghl.actualizarCitaEnCalendario({
    eventId: previo.ghl_event_id,
    calendarId: previo.calendar_id || actual?.calendarId,
    startISO: actual?.startTime, endISO: actual?.endTime, title: actual?.title,
    appointmentStatus: estado,
    description: actual?.description,
  });
  console.log(`ZOHO-CITA: ${zohoCitaID} marcada "${estado}" en GHL por acción "${accion}"`);
  return true;
}

/**
 * Un disparo sobre un registro ya espejado. La mayoría son reenvíos idénticos
 * del workflow de Creator y no hay que hacer nada, pero algunos son una
 * reprogramación real: el horario o el profesional cambiaron en Zoho.
 *
 * La comparación es contra citas_sync, no contra GHL, para no gastar una llamada
 * por cada reenvío — que son mayoría. Sólo cuando algo cambió se toca GHL.
 *
 * Se propagan horario y calendario, no el título. Una reprogramación mueve la
 * cita, no cambia de paciente, y reconstruir el título de una cita exigiría
 * volver a resolver el contacto en Zoho para nada.
 */
async function propagarCambios({ zohoCitaID, calendarId, startISO, endISO, inicioZoho, finZoho, esBloqueo, tituloBloqueo }) {
  const previo = await db.getCitaSync(zohoCitaID);
  if (!previo?.ghl_event_id) {
    // Reservado pero todavía sin evento: hay otro disparo del mismo registro en
    // vuelo. El que está creando va a confirmar; este no tiene qué actualizar.
    console.log(`ZOHO-CITA: ${zohoCitaID} reservada sin evento aún — se ignora este disparo`);
    return;
  }

  const cambios = [];
  if (previo.inicio && previo.inicio !== inicioZoho) cambios.push(`inicio ${previo.inicio} -> ${inicioZoho}`);
  if (previo.fin && previo.fin !== finZoho) cambios.push(`fin ${previo.fin} -> ${finZoho}`);
  if (previo.calendar_id && previo.calendar_id !== calendarId) cambios.push(`calendario ${previo.calendar_id} -> ${calendarId}`);

  if (!cambios.length) {
    console.log(`ZOHO-CITA: ${zohoCitaID} sin cambios — disparo repetido, se ignora`);
    return;
  }

  // Las filas anteriores a esta función no tienen inicio ni fin guardados, así
  // que no hay con qué comparar. Se completan ahora sin tocar GHL: la próxima
  // edición ya va a poder detectarse.
  if (!previo.inicio || !previo.fin) {
    await db.confirmarCitaZoho(zohoCitaID, previo.ghl_event_id, previo.calendar_id || calendarId, inicioZoho, finZoho);
    console.log(`ZOHO-CITA: ${zohoCitaID} sin horario previo registrado — se completa sin tocar GHL`);
    return;
  }

  if (esBloqueo) {
    await ghl.actualizarBloqueoEnCalendario({
      eventId: previo.ghl_event_id, calendarId, startISO, endISO, title: tituloBloqueo,
    });
  } else {
    // El PUT reemplaza en vez de parchear, así que el título y el estado se leen
    // y se devuelven tal cual; omitirlos los borraría.
    const actual = await ghl.getCitaEnCalendario(previo.ghl_event_id);
    await ghl.actualizarCitaEnCalendario({
      eventId: previo.ghl_event_id, calendarId, startISO, endISO,
      title: actual?.title, appointmentStatus: actual?.appointmentStatus,
      description: actual?.description,
    });
  }

  await db.confirmarCitaZoho(zohoCitaID, previo.ghl_event_id, calendarId, inicioZoho, finZoho);
  console.log(`ZOHO-CITA: ${zohoCitaID} reprogramada en GHL — ${cambios.join('; ')}`);
}

/**
 * POST /webhook/zoho-cita
 * Fired by a Zoho Creator workflow webhook when a new "Citas" record is added.
 * Mirrors that entry into the GHL calendar for its Consultor. Entries with a
 * Contacto become a real appointment (linked to the matching GHL contact);
 * entries without one (blocks, breaks, closures) become a block-slot instead,
 * since GHL's appointment endpoint requires a contactId and block-slots don't.
 */
async function zohoCitaWebhookHandler(req, res) {
  res.json({ success: true, received: true });

  // Fuera del try para que el catch pueda soltar la reserva si la creación falló.
  let zohoCitaID = '';

  try {
    const b = req.body || {};

    // The Consultor -> calendar routing had never been observable: an unmapped
    // consultant and a genuine clinic-wide block both fell through the same
    // `|| CALENDAR_GENERAL` without a word in the logs. Confirmed in production
    // on 2026-07-30 that all ~30 citas of the day landed on CALENDAR_GENERAL and
    // not one reached a therapist's calendar — invisible until the client
    // noticed it in the GHL calendar view. Logs the routing fields only, never
    // Observaciones or Email: these logs are not a PHI store.
    console.log('ZOHO-CITA payload:', JSON.stringify({
      claves: Object.keys(b),
      Consultor: b.Consultor,
      Contacto: b.Contacto,
      Tipo: b.Tipo,
      Inicio: b.Inicio,
      Fin: b.Fin,
      ID: b.ID,
    }));

    // Los botones de estado avisan con Accion y el ID del registro. Se resuelve
    // antes de cualquier otra cosa: no es una cita que espejar, es un cambio
    // sobre una que ya existe, y no necesita ni horario ni consultor.
    if (await aplicarEstado(b.Accion || b.accion, refZoho(b.ID) || refZoho(b.Cita))) return;

    const startISO = parseZohoDateTime(b.Inicio);
    const endISO = parseZohoDateTime(b.Fin);
    if (!startISO) { console.error('ZOHO-CITA: no se pudo interpretar Inicio:', b.Inicio); return; }

    const contactoRef = refZoho(b.Contacto);

    // The payload carries no Consultor, so the record is read back from
    // Citas_Report to recover it — see buscarCitaPorInicio in services/zoho.js.
    // Tipo and Observaciones come from there too: without them every entry was
    // titled a bare "Cita", blocks included.
    // Si Zoho no contesta NO se pierde la cita: se crea igual en el general y se
    // deja marcada. Pero se distingue de "no existe el registro", porque la
    // reparación es distinta — esta hay que reubicarla cuando Zoho vuelva.
    let registro = null, zohoIlegible = false;
    try {
      registro = await zoho.buscarCitaPorInicio(b.Inicio, contactoRef, b.Fin);
    } catch (err) {
      zohoIlegible = true;
      console.error(`ZOHO-CITA: ZOHO ILEGIBLE al rutear (${err.message}) — se archiva en CALENDAR_GENERAL para reubicar`);
    }
    const consultorID = refZoho(b.Consultor) || refZoho(registro?.Consultor);
    const calendarId = CALENDARIOS[consultorID] || CALENDAR_GENERAL;

    if (!consultorID) {
      console.log(zohoIlegible
        ? 'ZOHO-CITA: ruteo sin confirmar por fallo de Zoho — va a CALENDAR_GENERAL'
        : registro
          ? `ZOHO-CITA: la cita ${registro.ID} no tiene Consultor — va a CALENDAR_GENERAL`
          : 'ZOHO-CITA: no se encontró el registro en Citas_Report — va a CALENDAR_GENERAL');
    } else if (!CALENDARIOS[consultorID]) {
      console.error(
        'ZOHO-CITA: Consultor sin calendario mapeado, cae en CALENDAR_GENERAL —',
        JSON.stringify(registro?.Consultor || b.Consultor)
      );
    } else {
      console.log(`ZOHO-CITA: ruteada a ${registro?.Consultor?.display_value || consultorID} (calendario ${calendarId})`);
    }

    const tipo = b.Tipo || registro?.Tipo || 'Cita';
    const obs = b.Observaciones || registro?.Observaciones || '';

    // El workflow de Creator dispara varias veces por el mismo registro, y cada
    // disparo creaba otro evento: la auditoría del 2026-08-06 encontró 104 grupos
    // de eventos idénticos en julio-octubre, ninguno del backfill. Reservar el ID
    // antes de crear cierra también la carrera entre dos disparos simultáneos,
    // porque el INSERT es atómico y sólo uno se lleva la reserva.
    //
    // Sin registro en Citas_Report no hay ID que reservar. Se sigue igual: perder
    // la cita sería peor que arriesgar un duplicado, que ya sabemos detectar.
    zohoCitaID = registro?.ID || '';
    if (!(await db.reclamarCitaZoho(zohoCitaID, contactoRef ? 'cita' : 'bloqueo'))) {
      await propagarCambios({
        zohoCitaID, calendarId, startISO, endISO,
        inicioZoho: b.Inicio, finZoho: b.Fin,
        esBloqueo: !contactoRef,
        tituloBloqueo: tituloGHL([tipo, obs], tipo || 'Bloqueo'),
      });
      return;
    }

    // Sin Contacto no hay degradación que avisar: es un bloqueo de verdad
    // (Salida, Almuerzo, Festivo), que es exactamente lo que se quiere espejar.
    if (!contactoRef) {
      const title = tituloGHL([tipo, obs], tipo || 'Bloqueo');
      const bloqueo = await ghl.crearBloqueoEnCalendario({ calendarId, startISO, endISO, title });
      await db.confirmarCitaZoho(zohoCitaID, bloqueo?.id, calendarId, b.Inicio, b.Fin, 'bloqueo');
      console.log('ZOHO-CITA: bloqueo creado en GHL:', JSON.stringify(bloqueo));
      return;
    }

    // De acá para abajo el registro SÍ traía Contacto, así que cualquier bloqueo
    // es una cita degradada: alguien esperaba un recordatorio y no lo va a tener.
    let contacto = null, contactoIlegible = false;
    try {
      contacto = await zoho.getContactoPorId(contactoRef);
    } catch (err) {
      contactoIlegible = true;
      console.error(`ZOHO-CITA: ZOHO ILEGIBLE al leer el contacto ${contactoRef} (${err.message})`);
    }
    if (!contacto?.Movil) {
      await avisarDegradacion(
        contactoIlegible
          ? `Zoho no respondió al consultar el contacto ${contactoRef} — la cita quedó como bloqueo y hay que rehacerla`
          : contacto
            ? `el contacto ${contactoRef} existe en Zoho pero no tiene Movil`
            : `no se encontró el contacto Zoho ${contactoRef}`,
        { zohoCitaID, calendarId, inicio: b.Inicio, fin: b.Fin, tipo }
      );
      const bloqueo = await ghl.crearBloqueoEnCalendario({ calendarId, startISO, endISO, title: tituloGHL([tipo, obs], tipo || 'Bloqueo') });
      await db.confirmarCitaZoho(zohoCitaID, bloqueo?.id, calendarId, b.Inicio, b.Fin, 'bloqueo');
      console.log('ZOHO-CITA: bloqueo creado en GHL:', JSON.stringify(bloqueo));
      return;
    }

    const ghlContactId = await ghl.buscarOCrearContactoPorTelefono(contacto.Movil, contacto.Nombre_Completo);
    if (!ghlContactId) {
      await avisarDegradacion(
        `no se pudo resolver el contacto GHL para el Movil ${contacto.Movil}`,
        { zohoCitaID, calendarId, inicio: b.Inicio, fin: b.Fin, tipo }
      );
      const bloqueo = await ghl.crearBloqueoEnCalendario({ calendarId, startISO, endISO, title: tituloGHL([tipo, obs], tipo || 'Bloqueo') });
      await db.confirmarCitaZoho(zohoCitaID, bloqueo?.id, calendarId, b.Inicio, b.Fin, 'bloqueo');
      console.log('ZOHO-CITA: bloqueo creado en GHL:', JSON.stringify(bloqueo));
      return;
    }

    const title = tituloGHL([tipo, contacto.Nombre_Completo || 'NHC'], 'Cita');
    const appt = await ghl.crearCitaEnCalendario({ contactId: ghlContactId, calendarId, startISO, endISO, title, description: obs });
    await db.confirmarCitaZoho(zohoCitaID, appt?.id, calendarId, b.Inicio, b.Fin, 'cita');
    console.log('ZOHO-CITA: appointment creado en GHL:', JSON.stringify(appt));
  } catch (err) {
    // Nothing retries a cita: the 200 went out before any of this ran, so Zoho
    // considers it delivered. This line is the only trace the clinic gets that
    // an entry never reached GHL — it has to name the loss, not just the error.
    console.error('ZOHO-CITA: la entrada NO se sincronizó a GHL —', err.message);
    // Suelta la reserva para que un reenvío pueda reintentar. Sólo borra si no
    // llegó a asociarse un evento, así un fallo posterior a la creación no
    // reabre la puerta al duplicado que la reserva vino a evitar.
    await db.liberarCitaZoho(zohoCitaID);
  }
}

module.exports = { zohoCitaWebhookHandler, parseZohoDateTime, refZoho, tituloGHL, ESTADOS_GHL };
