const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

// ─── ZOHO CONFIG ───────────────────────────────────────────────────────────────
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || '1000.YU4EF3FZ0RS8NAEMKVPVNTS7DU23WK';
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'fc1adeeb598f9a6a7d38912922bfffcb1db6857203';
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || '1000.18ea8055151efce1711489d0475df2c9.6533e8fc2ee705c2af94f5a108312d26';

let zohoAccessToken = null;
let zohoTokenExpiry = 0;

async function getZohoAccessToken() {
  if (zohoAccessToken && Date.now() < zohoTokenExpiry) {
    return zohoAccessToken;
  }
  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN
    })
  });
  const data = await res.json();
  if (!data.access_token) {
    console.error('Error renovando token Zoho:', JSON.stringify(data));
    throw new Error('No se pudo obtener access token de Zoho');
  }
  zohoAccessToken = data.access_token;
  zohoTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log('Token Zoho renovado correctamente');
  return zohoAccessToken;
}

// ─── MAPEO OCUPACIÓN ──────────────────────────────────────────────────────────
function mapearOcupacion(ocupacionRaw) {
  const o = (ocupacionRaw || '').toLowerCase().trim();
  if (o.includes('ama') || o.includes('casa') || o.includes('hogar')) return 'Ama de casa';
  if (o.includes('deport') || o.includes('atleta') || o.includes('futbol') || o.includes('fútbol')) return 'Deportista';
  if (o.includes('desemplead') || o.includes('sin trabajo') || o.includes('buscando')) return 'Desempleado';
  if (o.includes('ejecutiv') || o.includes('gerente') || o.includes('director') || o.includes('jefe')) return 'Ejecutivo';
  if (o.includes('emplead') || o.includes('trabajador') || o.includes('operari')) return 'Empleado';
  if (o.includes('empresari') || o.includes('dueño') || o.includes('propietari') || o.includes('negocio')) return 'Empresario';
  if (o.includes('colegio') || o.includes('bachiller') || o.includes('secundaria')) return 'Estudiante de colegio';
  if (o.includes('universidad') || o.includes('universitari') || o.includes('carrera')) return 'Estudiante de universidad';
  if (o.includes('pension') || o.includes('jubilad') || o.includes('retirad')) return 'Pensionado';
  if (o.includes('terapeut') || o.includes('psicolog') || o.includes('médic') || o.includes('medic')) return 'Terapeuta';
  if (o.includes('programad') || o.includes('developer') || o.includes('software') || o.includes('sistem') || o.includes('tecnolog') || o.includes('ingenier')) return 'Empleado';
  return 'N.A';
}

// ─── CONSULTAR DISPONIBILIDAD ZOHO CALENDARIO ────────────────────────────────
async function getDisponibilidad(fechaISO) {
  // fechaISO: 'YYYY-MM-DD'
  try {
    const token = await getZohoAccessToken();
    // Buscar citas del día para Neurotecnologías y Mapeos
    const criteria = `(Inicio >= "${fechaISO} 00:00:00" && Inicio <= "${fechaISO} 23:59:59")`;
    const url = `https://creator.zoho.com/api/v2/visionintegralceo/calendario/report/Citas_Report?criteria=${encodeURIComponent(criteria)}&max_records=50`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Zoho-oauthtoken ${token}` }
    });
    const data = await res.json();
    console.log('DISPONIBILIDAD RESPONSE:', JSON.stringify(data).substring(0, 500));
    return data.data || [];
  } catch (err) {
    console.error('Error consultando disponibilidad:', err.message);
    return [];
  }
}

function calcularSlotsLibres(citas, fechaISO) {
  // Horario base según día de semana
  const fecha = new Date(fechaISO + 'T00:00:00');
  const diaSemana = fecha.getDay(); // 0=dom, 1=lun, 2=mar...6=sab

  let inicioHora, finHora;
  if (diaSemana === 0) return []; // domingo no hay
  if (diaSemana === 1) { inicioHora = 14; finHora = 15.5; } // lunes 2pm-3:30pm (1.5h = 1 slot)
  else if (diaSemana === 6) { inicioHora = 8.5; finHora = 10.5; } // sabado 8:30-10:30
  else { inicioHora = 8.5; finHora = 16.5; } // mar-vie 8:30-4:30

  // Ocupados en Neurotecnologías y Mapeos
  const ocupados = citas
    .filter(c => {
      const esp = (c.Espacio || '').toLowerCase();
      const cons = (c.Consultor || '').toLowerCase();
      return esp.includes('neurotecnolog') || esp.includes('mapeo') ||
             cons.includes('neurotecnolog') || cons.includes('mapeo');
    })
    .map(c => {
      const ini = new Date(c.Inicio);
      return ini.getHours() + ini.getMinutes() / 60;
    });

  // Slots de 1.5h (30min anamnesis + 1h mapeo) cada 30 min
  const slots = [];
  for (let h = inicioHora; h + 1.5 <= finHora; h += 0.5) {
    // Verificar que h y h+0.5 estén libres
    const bloqueado = ocupados.some(o => o >= h && o < h + 1.5);
    if (!bloqueado) {
      const hh = Math.floor(h);
      const mm = (h % 1) * 60;
      const label = `${hh}:${mm === 0 ? '00' : '30'}${hh < 12 ? 'am' : 'pm'}`;
      slots.push({ hora: h, label });
    }
  }
  return slots;
}

// ─── CREAR EN ANAMNESIS ───────────────────────────────────────────────────────
async function crearEnAnamnesis({ nombre, apellido, email, movil, contactIdGHL, edad, sintoma, genero, ocupacion }) {
  const token = await getZohoAccessToken();
  const headers = {
    'Authorization': `Zoho-oauthtoken ${token}`,
    'Content-Type': 'application/json'
  };

  const ocupacionMapeada = mapearOcupacion(ocupacion);

  // 1. Crear Contacto en v2
  const bodyContacto = {
    data: {
      Nombre_Completo: `${nombre} ${apellido}`.trim(),
      Email: email || '',
      Movil: (movil || '').replace(/[\s+\(\)\-]/g, ''),
      CRM: contactIdGHL || '',
      Edad: edad || '',
      Sintoma_o_necesidad: sintoma || '',
      Genero: genero || '',
      Ocupaci_n: ocupacionMapeada
    }
  };

  const resContacto = await fetch(
    'https://creator.zoho.com/api/v2/visionintegralceo/v2/form/Contactos',
    { method: 'POST', headers, body: JSON.stringify(bodyContacto) }
  );
  const dataContacto = await resContacto.json();
  console.log('ZOHO CONTACTO RESPONSE:', JSON.stringify(dataContacto));

  const contactoID = dataContacto?.data?.ID;
  if (!contactoID) throw new Error('No se obtuvo ID del contacto: ' + JSON.stringify(dataContacto));

  // 2. Crear Proceso en v2
  const bodyProceso = {
    data: {
      Nombrel_del_consultante: contactoID,
      Edad: edad || '',
      S_ntoma: sintoma || '',
      Genero: genero || '',
      Ocupaci_n: ocupacionMapeada,
      Tipo_Proceso: 'Diagnóstico',
      Estado_Paciente: 'Activo'
    }
  };

  const resProceso = await fetch(
    'https://creator.zoho.com/api/v2/visionintegralceo/v2/form/Procesos',
    { method: 'POST', headers, body: JSON.stringify(bodyProceso) }
  );
  const dataProceso = await resProceso.json();
  console.log('ZOHO PROCESO RESPONSE:', JSON.stringify(dataProceso));

  return { contactoID, dataProceso };
}

// ─── CREAR CITAS EN CALENDARIO ────────────────────────────────────────────────
async function crearCitasCalendario({ nombreContacto, movil, email, fechaISO, horaInicio, contactoID }) {
  const token = await getZohoAccessToken();
  const headers = {
    'Authorization': `Zoho-oauthtoken ${token}`,
    'Content-Type': 'application/json'
  };

  // Parsear hora inicio (ej: "13:00" o 13.0)
  let hIni, mIni;
  if (typeof horaInicio === 'string' && horaInicio.includes(':')) {
    [hIni, mIni] = horaInicio.split(':').map(Number);
  } else {
    hIni = Math.floor(horaInicio);
    mIni = (horaInicio % 1) * 60;
  }

  // Formatear fecha Zoho: dd-MMM-yyyy HH:mm:ss
  const meses = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(fechaISO + 'T00:00:00');
  const dd = String(d.getDate()).padStart(2, '0');
  const mmm = meses[d.getMonth()];
  const yyyy = d.getFullYear();

  const pad = n => String(n).padStart(2, '0');
  const fmtFecha = (h, m) => `${dd}-${mmm}-${yyyy} ${pad(h)}:${pad(m)}:00`;

  // Cita 1: Anamnesis — 30 min — Neurotecnologías — Neurotecnologías 1
  const ini1H = hIni, ini1M = mIni;
  const fin1H = mIni + 30 >= 60 ? hIni + 1 : hIni;
  const fin1M = (mIni + 30) % 60;

  // Cita 2: Mapeo — 1 hora — Mapeos — Mapeos (empieza donde termina la 1)
  const ini2H = fin1H, ini2M = fin1M;
  const fin2H = ini2M + 60 >= 60 ? ini2H + 1 : ini2H;
  const fin2M = (ini2M + 60) % 60;

  const baseCita = {
    Tipo: 'Presencial',
    Nombre_del_consultante: nombreContacto,
    Movil: (movil || '').replace(/[\s+\(\)\-]/g, ''),
    Email: email || '',
    Estado: 'Programada',
    Observaciones: 'NHC Kids - Agendado por Carolina IA'
  };

  const cita1 = {
    data: {
      ...baseCita,
      Inicio: fmtFecha(ini1H, ini1M),
      Fin: fmtFecha(fin1H, fin1M),
      Duraci_n: '30 minutos',
      Consultor: 'Neurotecnologías',
      Espacio: 'Neurotecnologías 1',
      Dia: `${dd}-${mmm}-${yyyy}`
    }
  };

  const cita2 = {
    data: {
      ...baseCita,
      Inicio: fmtFecha(ini2H, ini2M),
      Fin: fmtFecha(fin2H, fin2M),
      Duraci_n: '1 hora',
      Consultor: 'Mapeos',
      Espacio: 'Mapeos',
      Dia: `${dd}-${mmm}-${yyyy}`
    }
  };

  const res1 = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/calendario/form/Citas', {
    method: 'POST', headers, body: JSON.stringify(cita1)
  });
  const data1 = await res1.json();
  console.log('CITA 1 ANAMNESIS:', JSON.stringify(data1));

  const res2 = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/calendario/form/Citas', {
    method: 'POST', headers, body: JSON.stringify(cita2)
  });
  const data2 = await res2.json();
  console.log('CITA 2 MAPEO:', JSON.stringify(data2));

  return { cita1: data1, cita2: data2 };
}

// ─── HELPERS GHL ──────────────────────────────────────────────────────────────
const conversationHistory = {};
const disponibilidadCache = {}; // cache por conversación

const humanDelay = () => new Promise(resolve =>
  setTimeout(resolve, Math.floor(Math.random() * 4000) + 2000)
);

async function getContact(contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15' }
  });
  return await res.json();
}

async function getConversationId(contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/conversations/search?contactId=${contactId}&locationId=${GHL_LOCATION_ID}`, {
    headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15' }
  });
  const data = await res.json();
  return data.conversations?.[0]?.id || null;
}

async function getLastMessage(conversationId) {
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=5`, {
      headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15' }
    });
    const data = await res.json();
    const messages = data.messages?.messages || data.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const lastInbound = messages.find(m => m.direction === 'inbound');
    return lastInbound?.body || messages[0]?.body || '';
  } catch (err) {
    console.error('Error getLastMessage:', err);
    return '';
  }
}

async function addTag(contactId, tag) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [tag] })
  });
}

async function sendMessage(conversationId, message, contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'WhatsApp', conversationId, contactId, message })
  });
  const data = await res.json();
  console.log('SEND MESSAGE RESPONSE:', JSON.stringify(data));
}

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Servidor NHC Kids activo ✓'));

app.post('/webhook/ghl', async (req, res) => {
  try {
    console.log('BODY RECIBIDO:', JSON.stringify(req.body));

    const contactId = req.body.contactId || req.body.customData?.contactId ||
                      req.body.contact_id || req.body.contact?.id;
    const conversationId_raw = req.body.conversationId || req.body.customData?.conversationId || '';
    let conversationId = conversationId_raw;
    const message = req.body.message?.body || req.body.customData?.message || '';

    if (!contactId) return res.status(400).json({ error: 'Faltan datos' });
    if (!conversationId) conversationId = await getConversationId(contactId);
    if (!conversationId) return res.status(400).json({ error: 'No se encontró conversación' });

    const contactData = await getContact(contactId);
    const contact = contactData.contact || {};
    const tags = contact.tags || [];

    if (!tags.includes('terminó triaje nhck') || tags.includes('escalado nhck')) {
      return res.json({ success: true, skipped: true });
    }

    const lastMessage = message || await getLastMessage(conversationId);
    if (!lastMessage) return res.json({ success: true, skipped: true, reason: 'No message found' });

    const nombre = contact.firstName || 'Hola';
    const triaje1 = req.body['Triaje NHC - Principal dificultad'] || 'No respondido';
    const triaje2 = req.body['Triaje NHC - Tiempo observando'] || 'No respondido';
    const triaje3 = Array.isArray(req.body['Triaje NHC - Intentos previos'])
                    ? req.body['Triaje NHC - Intentos previos'].join(', ')
                    : req.body['Triaje NHC - Intentos previos'] || 'No respondido';
    const triaje4 = req.body['Triaje NHC - Área más afectada'] || 'No respondido';
    const triaje5 = req.body['Triaje NHC - Nivel de compromiso'] || 'No respondido';
    console.log('TRIAJE DATA:', { triaje1, triaje2, triaje3, triaje4, triaje5 });

    if (!conversationHistory[conversationId]) conversationHistory[conversationId] = [];

    conversationHistory[conversationId].push({
      role: 'user',
      content: [{ type: 'text', text: lastMessage }]
    });
    if (conversationHistory[conversationId].length > 20) {
      conversationHistory[conversationId] = conversationHistory[conversationId].slice(-20);
    }

    // Consultar disponibilidad para los próximos 5 días hábiles
    let disponibilidadTexto = '';
    try {
      const hoy = new Date();
      const slots = [];
      let diasRevisados = 0;
      let diaOffset = 1;
      while (slots.length < 3 && diasRevisados < 10) {
        const fecha = new Date(hoy);
        fecha.setDate(hoy.getDate() + diaOffset);
        const diaSemana = fecha.getDay();
        if (diaSemana !== 0) { // no domingo
          const fechaISO = fecha.toISOString().split('T')[0];
          const cacheKey = `${conversationId}_${fechaISO}`;
          let citas = disponibilidadCache[cacheKey];
          if (!citas) {
            citas = await getDisponibilidad(fechaISO);
            disponibilidadCache[cacheKey] = citas;
          }
          const slotsLibres = calcularSlotsLibres(citas, fechaISO);
          if (slotsLibres.length > 0) {
            const diasNombres = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
            const mesesNombres = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
            slots.push(`${diasNombres[diaSemana]} ${fecha.getDate()} de ${mesesNombres[fecha.getMonth()]}: ${slotsLibres.slice(0,3).map(s=>s.label).join(', ')}`);
          }
          diasRevisados++;
        }
        diaOffset++;
      }
      disponibilidadTexto = slots.length > 0
        ? slots.join('\n')
        : 'No se encontró disponibilidad en los próximos días, ofrece coordinar manualmente.';
    } catch (err) {
      console.error('Error consultando disponibilidad:', err.message);
      disponibilidadTexto = 'Disponibilidad no consultada. Ofrece los horarios generales: lunes 2-3:30pm, martes a viernes 8:30am-4:30pm, sábado 8:30-10:30am.';
    }

    const systemPrompt = `Eres Carolina, asesora experta de NHC Kids. Escribes por WhatsApp como una persona real — cálida, cercana y profesional.

CONTEXTO CRÍTICO:
- ${nombre} es el PADRE o MADRE, no el niño. NUNCA digas "ayudar a ${nombre}".
- Ya completaron el triaje. TIENES toda su información. NUNCA digas que no tienes sus datos.
- Tu primer mensaje SIEMPRE debe demostrar que leíste el triaje — menciona lo que respondieron.

TRIAJE COMPLETADO POR ${nombre}:
- Principal dificultad del hijo/a: ${triaje1}
- Tiempo observando esta situación: ${triaje2}
- Lo que han intentado antes: ${triaje3}
- Área más afectada si no intervienen: ${triaje4}
- Nivel de compromiso familiar: ${triaje5}

SOBRE NHC KIDS:
Centro especializado en comprensión integral del neurodesarrollo infantil.
No etiquetamos — comprendemos.
Ayudamos a familias a entender qué le pasa realmente a su hijo, intervenir con precisión y acompañar el proceso con coherencia.

EL NEUROMAPEO KIDS (programa diagnóstico):
- Neuromapeo cerebral (vemos cómo funciona realmente su cerebro)
- Evaluación clínica completa
- Sesión de devolución estratégica (te explicamos TODO lo que encontramos)
- Plan de intervención personalizado (qué hacer y cómo)
Precio: $395.000 COP
Reserva: $100.000 COP (el resto se paga al llegar)

DISPONIBILIDAD REAL DEL CALENDARIO (usa SOLO estos horarios):
${disponibilidadTexto}

RECOLECCIÓN DE DATOS (OBLIGATORIO antes de confirmar cita):
Antes de proponer día y hora necesitas:
- Edad del niño/a
- Género del niño/a (niño/niña)
- Ocupación del padre/madre
Recógelos de forma natural, no como formulario. Puedes preguntar los 3 en un solo mensaje.

OCUPACIONES VÁLIDAS (mapea la respuesta del padre a una de estas):
Ama de casa, Deportista, Desempleado, Ejecutivo, Empleado, Empresario, Estudiante de colegio, Estudiante de universidad, Pensionado, Terapeuta, N.A

CONFIRMACIÓN DE CITA:
Cuando ya tengas edad, género y ocupación, propón UN horario específico de la disponibilidad real.
Cuando el padre/madre confirme con "sí", "de acuerdo", "perfecto", "listo" o similar,
responde EXACTAMENTE así (sin nada más):
[CITA_CONFIRMADA]
fecha: <YYYY-MM-DD>
hora: <HH:MM en formato 24h>
edad: <edad del niño>
genero: <niño o niña>
ocupacion: <ocupación tal como la dijo el padre>

CÓMO USAR EL TRIAJE:
- Si pregunta qué hacen → explica el Neuromapeo y conéctalo con ${triaje1}
- Si pregunta si sirve → "Sí, especialmente porque llevan ${triaje2} con esto y ya intentaron ${triaje3}"
- Si pregunta precio → explica el valor, menciona reserva de $100.000
- Si pregunta cuándo → ofrece SOLO los horarios de la disponibilidad real

MANEJO DE OBJECIONES:
- Precio alto → "Lo que cuesta más es seguir sin claridad. La reserva son solo $100.000 y el resto al llegar."
- Dudas → "Con ${triaje2} observando ${triaje1}, esto es exactamente para lo que está diseñado."
- Horarios → propón opciones de la disponibilidad real únicamente

ESCALADO — responde SOLO con [ESCALAR] cuando:
- Te preguntan algo fuera de tu conocimiento
- El lead pide hablar con alguien del equipo

REGLAS ESTRICTAS:
- Mensajes MUY cortos — máximo 3 líneas continuas, SIN líneas en blanco entre ellas
- NUNCA separes las líneas con espacios vacíos — escribe como un solo bloque de texto
- Tono humano y cálido como WhatsApp real
- NUNCA digas que eres IA
- NUNCA digas que no tienes información del triaje
- SIEMPRE usa el triaje para personalizar
- Solo en español
- NUNCA ofrezcas horarios que no estén en la disponibilidad real`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        system: systemPrompt,
        messages: conversationHistory[conversationId]
      })
    });

    const claudeData = await claudeRes.json();
    console.log('CLAUDE RESPONSE:', JSON.stringify(claudeData));
    const reply = claudeData.content[0].text
      .split('\n')
      .filter(line => line.trim() !== '')
      .join('\n');

    // ─── MANEJO [CITA_CONFIRMADA] ────────────────────────────────────────────
    if (reply.includes('[CITA_CONFIRMADA]')) {
      console.log('CITA CONFIRMADA DETECTADA');

      const extractField = (field) => {
        const match = reply.match(new RegExp(`${field}:\\s*(.+)`));
        return match ? match[1].trim() : '';
      };

      const fechaCita  = extractField('fecha');
      const horaCita   = extractField('hora');
      const edad       = extractField('edad');
      const genero     = extractField('genero');
      const ocupacion  = extractField('ocupacion');

      console.log('DATOS CITA:', { fechaCita, horaCita, edad, genero, ocupacion });

      // Crear en Anamnesis
      let contactoID = null;
      try {
        const resultado = await crearEnAnamnesis({
          nombre: contact.firstName || '',
          apellido: contact.lastName || '',
          email: contact.email || '',
          movil: contact.phone || '',
          contactIdGHL: contactId,
          edad,
          sintoma: triaje1,
          genero,
          ocupacion
        });
        contactoID = resultado.contactoID;
        console.log('ANAMNESIS CREADO:', JSON.stringify(resultado));
      } catch (err) {
        console.error('Error creando en Anamnesis:', err.message);
      }

      // Crear citas en Calendario
      try {
        const citas = await crearCitasCalendario({
          nombreContacto: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          movil: contact.phone || '',
          email: contact.email || '',
          fechaISO: fechaCita,
          horaInicio: horaCita,
          contactoID
        });
        console.log('CITAS CALENDARIO CREADAS:', JSON.stringify(citas));
      } catch (err) {
        console.error('Error creando citas en calendario:', err.message);
      }

      // Formato fecha legible para el mensaje
      const [yyyy, mm, dd] = (fechaCita || '').split('-');
      const mesesNombres = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      const fechaLegible = fechaCita ? `${parseInt(dd)} de ${mesesNombres[parseInt(mm)-1]}` : 'la fecha acordada';
      const [hh, min] = (horaCita || '00:00').split(':');
      const horaLegible = `${parseInt(hh)}:${min}${parseInt(hh) < 12 ? 'am' : 'pm'}`;

      await addTag(contactId, 'escalado nhck');
      await humanDelay();
      await sendMessage(
        conversationId,
        `¡Perfecto ${nombre}! Tu cita queda agendada para el ${fechaLegible} a las ${horaLegible} 🎉\nEn un momento un asesor te confirmará los detalles finales 🙌`,
        contactId
      );

      return res.json({ success: true, citaConfirmada: true, escalated: true });
    }

    // ─── MANEJO [ESCALAR] ────────────────────────────────────────────────────
    if (reply.includes('[ESCALAR]')) {
      await addTag(contactId, 'escalado nhck');
      await humanDelay();
      await sendMessage(conversationId, 'En un momento un asesor del área de ventas te va a ayudar con esto 🙌', contactId);
      return res.json({ success: true, escalated: true });
    }

    // ─── RESPUESTA NORMAL ────────────────────────────────────────────────────
    conversationHistory[conversationId].push({
      role: 'assistant',
      content: [{ type: 'text', text: reply }]
    });

    await humanDelay();
    await sendMessage(conversationId, reply, contactId);
    res.json({ success: true, reply });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));