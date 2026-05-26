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

// IDs fijos de Consultores y Espacios
const ID_CONSULTOR_NEUROTECNOLOGIAS = '3572150000004871156';
const ID_CONSULTOR_MAPEOS = '3572150000005140253';
const ID_ESPACIO_NEUROTECNOLOGIAS_1 = '3572150000004826066';
const ID_ESPACIO_MAPEOS = '3572150000004871116';

let zohoAccessToken = null;
let zohoTokenExpiry = 0;

async function getZohoAccessToken() {
  if (zohoAccessToken && Date.now() < zohoTokenExpiry) return zohoAccessToken;
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
  if (!data.access_token) throw new Error('No se pudo obtener access token: ' + JSON.stringify(data));
  zohoAccessToken = data.access_token;
  zohoTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log('Token Zoho renovado');
  return zohoAccessToken;
}

// ─── MAPEO SÍNTOMA ───────────────────────────────────────────────────────────
function mapearSintoma(sintomaRaw) {
  const s = (sintomaRaw || '').toLowerCase().trim();
  if (s.includes('ansiedad') || s.includes('miedo') || s.includes('inseguridad') || s.includes('temor')) return 'Ansiedad';
  if (s.includes('autis')) return 'Autismo';
  if (s.includes('autoestima') || s.includes('confianza') || s.includes('seguridad en sí')) return 'Autoestima';
  if (s.includes('deficit') || s.includes('déficit') || s.includes('atención') || s.includes('concentra') || s.includes('tdah')) return 'Déficit de atención';
  if (s.includes('depres')) return 'Depresión1';
  if (s.includes('cognitiv') || s.includes('memoria') || s.includes('aprendizaje cogn')) return 'Desarrollo Cognitivo';
  if (s.includes('desarrollo personal') || s.includes('crecimiento')) return 'Desarrollo personal';
  if (s.includes('aprendizaje') || s.includes('escolar') || s.includes('leer') || s.includes('escribir') || s.includes('dislexia')) return 'Dificultades de aprendizaje';
  if (s.includes('pareja') || s.includes('relación')) return 'Dificultades de pareja';
  if (s.includes('duelo') || s.includes('pérdida') || s.includes('muerte')) return 'Duelo';
  if (s.includes('estrés') || s.includes('estres') || s.includes('tensión')) return 'Estrés';
  if (s.includes('ruptura') || s.includes('separac')) return 'Ruptura';
  if (s.includes('toc') || s.includes('obsesiv') || s.includes('compulsiv')) return 'TOC (Transtorno Obsesivo C...)';
  if (s.includes('tod') || s.includes('oposicion') || s.includes('oposición') || s.includes('desafiante')) return 'TOD (Transtorno Oposicion...)';
  if (s.includes('conducta') || s.includes('comportamiento') || s.includes('agresiv')) return 'Otros';
  if (!s || s === 'no respondido') return 'Sin información';
  return 'Otros';
}

// ─── MAPEO GÉNERO ─────────────────────────────────────────────────────────────
function mapearGenero(generoRaw) {
  const g = (generoRaw || '').toLowerCase().trim();
  if (g.includes('mascul') || g.includes('niño') || g.includes('hombre') || g.includes('varon') || g.includes('varón') || g === 'm') return 'Masculino';
  if (g.includes('femen') || g.includes('niña') || g.includes('mujer') || g.includes('chica') || g === 'f') return 'Femenino';
  return 'Otro';
}

// ─── MAPEO OCUPACIÓN ──────────────────────────────────────────────────────────
function mapearOcupacion(ocupacionRaw) {
  const o = (ocupacionRaw || '').toLowerCase().trim();
  if (o.includes('ama') || o.includes('hogar')) return 'Ama de casa';
  if (o.includes('deport') || o.includes('atleta')) return 'Deportista';
  if (o.includes('desemplead') || o.includes('sin trabajo')) return 'Desempleado';
  if (o.includes('ejecutiv') || o.includes('gerente') || o.includes('director')) return 'Ejecutivo';
  if (o.includes('empresari') || o.includes('dueño') || o.includes('negocio')) return 'Empresario';
  if (o.includes('colegio') || o.includes('bachiller') || o.includes('secundaria')) return 'Estudiante de colegio';
  if (o.includes('universidad') || o.includes('universitari')) return 'Estudiante de universidad';
  if (o.includes('pension') || o.includes('jubilad') || o.includes('retirad')) return 'Pensionado';
  if (o.includes('terapeut') || o.includes('psicolog') || o.includes('médic') || o.includes('medic')) return 'Terapeuta';
  if (o.includes('emplead') || o.includes('trabajador') || o.includes('programad') ||
      o.includes('developer') || o.includes('software') || o.includes('ingenier') ||
      o.includes('tecnolog') || o.includes('sistem') || o.includes('operari')) return 'Empleado';
  return 'N.A';
}

// ─── BUSCAR CONTACTO EXISTENTE EN ANAMNESIS ───────────────────────────────────
async function buscarContactoAnamnesis(movil, email) {
  try {
    const token = await getZohoAccessToken();
    const movilLimpio = (movil || '').replace(/[\s+\(\)\-]/g, '');
    
    // Buscar por móvil
    if (movilLimpio) {
      const res = await fetch(
        `https://creator.zoho.com/api/v2/visionintegralceo/v2/report/Contactos_Report?criteria=Movil%3D%22${movilLimpio}%22&max_records=1`,
        { headers: { 'Authorization': `Zoho-oauthtoken ${token}` } }
      );
      const data = await res.json();
      if (data?.data?.length > 0) {
        console.log('Contacto existente encontrado por móvil:', data.data[0].ID);
        return data.data[0].ID;
      }
    }

    // Buscar por email
    if (email) {
      const res = await fetch(
        `https://creator.zoho.com/api/v2/visionintegralceo/v2/report/Contactos_Report?criteria=Email%3D%22${encodeURIComponent(email)}%22&max_records=1`,
        { headers: { 'Authorization': `Zoho-oauthtoken ${token}` } }
      );
      const data = await res.json();
      if (data?.data?.length > 0) {
        console.log('Contacto existente encontrado por email:', data.data[0].ID);
        return data.data[0].ID;
      }
    }

    return null;
  } catch (err) {
    console.error('Error buscando contacto:', err.message);
    return null;
  }
}

// ─── CREAR EN ANAMNESIS (con verificación de duplicado) ───────────────────────
async function crearEnAnamnesis({ nombre, apellido, email, movil, contactIdGHL, edad, sintoma, genero, ocupacion }) {
  const token = await getZohoAccessToken();
  const headers = { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
  const movilLimpio = (movil || '').replace(/[\s+\(\)\-]/g, '');
  const generoMapeado = mapearGenero(genero);
  const ocupacionMapeada = mapearOcupacion(ocupacion);

  // Verificar si ya existe
  let contactoID = await buscarContactoAnamnesis(movilLimpio, email);

  if (!contactoID) {
    // Crear contacto nuevo
    const bodyContacto = {
      data: {
        Nombre_Completo: `${nombre} ${apellido}`.trim(),
        Email: email || '',
        Movil: movilLimpio,
        CRM: contactIdGHL || '',
        Edad: edad || '',
        Sintoma_o_necesidad: mapearSintoma(sintoma),
        Genero: generoMapeado,
        Ocupaci_n: ocupacionMapeada
      }
    };
    const resContacto = await fetch(
      'https://creator.zoho.com/api/v2/visionintegralceo/v2/form/Contactos',
      { method: 'POST', headers, body: JSON.stringify(bodyContacto) }
    );
    const dataContacto = await resContacto.json();
    console.log('ZOHO CONTACTO RESPONSE:', JSON.stringify(dataContacto));
    contactoID = dataContacto?.data?.ID;
    if (!contactoID) throw new Error('No se obtuvo ID del contacto: ' + JSON.stringify(dataContacto));
  } else {
    console.log('Contacto ya existe, usando ID:', contactoID);
  }

  // Crear proceso
  const bodyProceso = {
    data: {
      Nombrel_del_consultante: contactoID,
      Edad: edad || '',
      S_ntoma: mapearSintoma(sintoma),
      Genero: generoMapeado,
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
  const headers = { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };

  let hIni, mIni;
  if (typeof horaInicio === 'string' && horaInicio.includes(':')) {
    [hIni, mIni] = horaInicio.split(':').map(Number);
  } else {
    hIni = Math.floor(horaInicio);
    mIni = (horaInicio % 1) * 60;
  }

  const meses = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(fechaISO + 'T00:00:00');
  const dd = String(d.getDate()).padStart(2, '0');
  const mmm = meses[d.getMonth()];
  const yyyy = d.getFullYear();
  const pad = n => String(n).padStart(2, '0');
  const fmtFecha = (h, m) => `${dd}-${mmm}-${yyyy} ${pad(h)}:${pad(m)}:00`;

  // Cita 1: Anamnesis 30min
  const fin1H = mIni + 30 >= 60 ? hIni + 1 : hIni;
  const fin1M = (mIni + 30) % 60;

  // Cita 2: Mapeo 1hora (empieza donde termina la 1)
  const ini2H = fin1H, ini2M = fin1M;
  const fin2H = ini2M + 60 >= 60 ? ini2H + 1 : ini2H;
  const fin2M = (ini2M + 60) % 60;

  const baseCita = {
    Tipo: 'Presencial',
    Contacto: contactoID || '',
    Movil: movilLimpio,
    Email: email || '',
    Estado: 'Programada',
    Observaciones: 'NHC Kids - Agendado por Carolina IA'
  };

  const movilLimpio = (movil || '').replace(/[\s+\(\)\-]/g, '');
  const diaStr = `${dd}-${mmm}-${yyyy}`;

  const cita1 = {
    data: {
      ...baseCita,
      Inicio: fmtFecha(hIni, mIni),
      Fin: fmtFecha(fin1H, fin1M),
      Duraci_n: '30 minutos',
      Consultor: ID_CONSULTOR_NEUROTECNOLOGIAS,
      Espacio: ID_ESPACIO_NEUROTECNOLOGIAS_1,
      Dia: diaStr
    }
  };

  const cita2 = {
    data: {
      ...baseCita,
      Inicio: fmtFecha(ini2H, ini2M),
      Fin: fmtFecha(fin2H, fin2M),
      Duraci_n: '1 hora',
      Consultor: ID_CONSULTOR_MAPEOS,
      Espacio: ID_ESPACIO_MAPEOS,
      Dia: diaStr
    }
  };('https://creator.zoho.com/api/v2/visionintegralceo/calendario/form/Citas',
    { method: 'POST', headers, body: JSON.stringify(cita1) });
  const data1 = await res1.json();
  console.log('CITA 1 ANAMNESIS:', JSON.stringify(data1));

  const res2 = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/calendario/form/Citas',
    { method: 'POST', headers, body: JSON.stringify(cita2) });
  const data2 = await res2.json();
  console.log('CITA 2 MAPEO:', JSON.stringify(data2));

  return { cita1: data1, cita2: data2 };
}

// ─── CONSULTAR DISPONIBILIDAD ─────────────────────────────────────────────────
async function getDisponibilidad(fechaISO) {
  try {
    const token = await getZohoAccessToken();
    const criteria = `(Inicio >= "${fechaISO} 00:00:00" && Inicio <= "${fechaISO} 23:59:59")`;
    const url = `https://creator.zoho.com/api/v2/visionintegralceo/calendario/report/Citas_Report?criteria=${encodeURIComponent(criteria)}&max_records=50`;
    const res = await fetch(url, { headers: { 'Authorization': `Zoho-oauthtoken ${token}` } });
    const data = await res.json();
    return data.data || [];
  } catch (err) {
    console.error('Error consultando disponibilidad:', err.message);
    return [];
  }
}

function calcularSlotsLibres(citas, fechaISO) {
  const fecha = new Date(fechaISO + 'T00:00:00');
  const diaSemana = fecha.getDay();
  if (diaSemana === 0) return [];

  let inicioHora, finHora;
  if (diaSemana === 1) { inicioHora = 14; finHora = 15.5; }
  else if (diaSemana === 6) { inicioHora = 8.5; finHora = 10.5; }
  else { inicioHora = 8.5; finHora = 16.5; }

  // Obtener horas ocupadas en Neurotecnologías 1 y Mapeos
  const ocupados = citas.map(c => {
    const consultorID = c.Consultor?.ID || '';
    const espacioID = c.Espacio?.ID || '';
    const esRelevante = consultorID === ID_CONSULTOR_NEUROTECNOLOGIAS ||
                        consultorID === ID_CONSULTOR_MAPEOS ||
                        espacioID === ID_ESPACIO_NEUROTECNOLOGIAS_1 ||
                        espacioID === ID_ESPACIO_MAPEOS;
    if (!esRelevante) return null;
    const ini = new Date(c.Inicio?.replace(/-/g, ' ') || '');
    if (isNaN(ini)) return null;
    return ini.getHours() + ini.getMinutes() / 60;
  }).filter(h => h !== null);

  const slots = [];
  for (let h = inicioHora; h + 1.5 <= finHora; h += 0.5) {
    const bloqueado = ocupados.some(o => o >= h && o < h + 1.5);
    if (!bloqueado) {
      const hh = Math.floor(h);
      const mm = (h % 1) * 60;
      const sufijo = hh < 12 ? 'am' : 'pm';
      const hh12 = hh > 12 ? hh - 12 : hh;
      const label = `${hh12}:${mm === 0 ? '00' : '30'}${sufijo}`;
      const horaISO = `${String(hh).padStart(2,'0')}:${mm === 0 ? '00' : '30'}`;
      slots.push({ hora: h, label, horaISO });
    }
  }
  return slots;
}

// ─── HELPERS GHL ──────────────────────────────────────────────────────────────
const conversationHistory = {};
const disponibilidadCache = {};

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
    conversationHistory[conversationId].push({ role: 'user', content: [{ type: 'text', text: lastMessage }] });
    if (conversationHistory[conversationId].length > 20) {
      conversationHistory[conversationId] = conversationHistory[conversationId].slice(-20);
    }

    // Consultar disponibilidad real próximos días hábiles
    let disponibilidadTexto = '';
    let slotsDisponibles = [];
    try {
      const hoy = new Date();
      let diaOffset = 1;
      let diasConSlots = 0;
      const mesesNombres = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      const diasNombres = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

      while (diasConSlots < 3 && diaOffset <= 14) {
        const fecha = new Date(hoy);
        fecha.setDate(hoy.getDate() + diaOffset);
        const diaSemana = fecha.getDay();
        if (diaSemana !== 0) {
          const fechaISO = fecha.toISOString().split('T')[0];
          const cacheKey = fechaISO;
          if (!disponibilidadCache[cacheKey]) {
            disponibilidadCache[cacheKey] = await getDisponibilidad(fechaISO);
          }
          const slots = calcularSlotsLibres(disponibilidadCache[cacheKey], fechaISO);
          if (slots.length > 0) {
            const labelDia = `${diasNombres[diaSemana]} ${fecha.getDate()} de ${mesesNombres[fecha.getMonth()]}`;
            const slotsMostrar = slots.slice(0, 3);
            slotsDisponibles.push({ fechaISO, labelDia, slots: slotsMostrar });
            disponibilidadTexto += `${labelDia}: ${slotsMostrar.map(s => s.label).join(', ')}\n`;
            diasConSlots++;
          }
        }
        diaOffset++;
      }
      if (!disponibilidadTexto) disponibilidadTexto = 'Sin disponibilidad encontrada en los próximos días.';
    } catch (err) {
      console.error('Error disponibilidad:', err.message);
      disponibilidadTexto = 'Disponibilidad no consultada. Usa horarios generales: lunes 2-3:30pm, martes a viernes 8:30am-4:30pm, sábado 8:30-10:30am.';
    }

    const systemPrompt = `Eres Carolina, asesora experta de NHC Kids. Escribes por WhatsApp como una persona real — cálida, cercana y profesional.

CONTEXTO CRÍTICO:
- ${nombre} es el PADRE o MADRE, no el niño. NUNCA digas "ayudar a ${nombre}".
- Ya completaron el triaje. TIENES toda su información. NUNCA digas que no tienes sus datos.
- Tu primer mensaje SIEMPRE debe demostrar que leíste el triaje.

TRIAJE COMPLETADO POR ${nombre}:
- Principal dificultad del hijo/a: ${triaje1}
- Tiempo observando: ${triaje2}
- Lo que han intentado: ${triaje3}
- Área más afectada: ${triaje4}
- Nivel de compromiso: ${triaje5}

SOBRE NHC KIDS:
Centro especializado en neurodesarrollo infantil. No etiquetamos — comprendemos.
EL NEUROMAPEO KIDS: Neuromapeo cerebral + Evaluación clínica + Devolución estratégica + Plan personalizado.
Precio: $395.000 COP. Reserva: $100.000 COP (resto al llegar).

DISPONIBILIDAD REAL DEL CALENDARIO (SOLO puedes ofrecer estos horarios exactos):
${disponibilidadTexto}
REGLA CRÍTICA: NUNCA confirmes ni aceptes un horario que el padre proponga si no está en esta lista. Si propone algo diferente, dile que ese horario no está disponible y ofrece las opciones reales.

RECOLECCIÓN DE DATOS (OBLIGATORIO antes de confirmar cita):
Necesitas: edad del niño/a, género del niño/a, ocupación del padre/madre.
Recógelos de forma natural en un solo mensaje si es posible.

GÉNEROS VÁLIDOS: Masculino (niño/hombre), Femenino (niña/mujer), Otro.
OCUPACIONES VÁLIDAS: Ama de casa, Deportista, Desempleado, Ejecutivo, Empleado, Empresario, Estudiante de colegio, Estudiante de universidad, Pensionado, Terapeuta, N.A.

CONFIRMACIÓN DE CITA:
Cuando tengas edad, género, ocupación Y el padre confirme un horario de la lista disponible, responde EXACTAMENTE así (sin texto adicional antes):
[CITA_CONFIRMADA]
fecha: <YYYY-MM-DD>
hora: <HH:MM en 24h>
edad: <edad>
genero: <Masculino/Femenino/Otro>
ocupacion: <ocupación tal como la dijo>

OBJECIONES:
- Precio → "La reserva son solo $100.000 y el resto al llegar."
- Dudas → "Con ${triaje2} observando ${triaje1}, esto es exactamente para lo que está diseñado."
- Horario no disponible → "Ese horario no lo tengo libre, pero puedo ofrecerte: [lista disponible]"

ESCALAR solo con [ESCALAR] cuando pida hablar con alguien o salga de tu conocimiento.

REGLAS:
- Máximo 3 líneas continuas SIN líneas en blanco
- Tono humano WhatsApp
- NUNCA digas que eres IA
- NUNCA menciones datos bancarios, cuentas, transferencias ni números de consignación
- NUNCA inventes información de pago — eso lo maneja el equipo humano`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
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
      .split('\n').filter(line => line.trim() !== '').join('\n');

    // ─── CITA CONFIRMADA ────────────────────────────────────────────────────
    if (reply.includes('[CITA_CONFIRMADA]')) {
      console.log('CITA CONFIRMADA DETECTADA');
      const extract = field => { const m = reply.match(new RegExp(`${field}:\\s*(.+)`)); return m ? m[1].trim() : ''; };
      const fechaCita = extract('fecha');
      const horaCita  = extract('hora');
      const edad      = extract('edad');
      const genero    = extract('genero');
      const ocupacion = extract('ocupacion');
      console.log('DATOS CITA:', { fechaCita, horaCita, edad, genero, ocupacion });

      try {
        const resultado = await crearEnAnamnesis({
          nombre: contact.firstName || '',
          apellido: contact.lastName || '',
          email: contact.email || '',
          movil: contact.phone || '',
          contactIdGHL: contactId,
          edad, sintoma: triaje1, genero, ocupacion
        });
        console.log('ANAMNESIS OK:', JSON.stringify(resultado));
      } catch (err) {
        console.error('Error Anamnesis:', err.message);
      }

      try {
        const citas = await crearCitasCalendario({
          nombreContacto: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
          movil: contact.phone || '',
          email: contact.email || '',
          fechaISO: fechaCita,
          horaInicio: horaCita,
          contactoID: resultado?.contactoID || null
        });
        console.log('CITAS CALENDARIO OK:', JSON.stringify(citas));
      } catch (err) {
        console.error('Error Citas Calendario:', err.message);
      }

      const mesesNombres = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      const [yyyy, mm, dd] = (fechaCita || '').split('-');
      const fechaLegible = fechaCita ? `${parseInt(dd)} de ${mesesNombres[parseInt(mm)-1]}` : 'la fecha acordada';
      const [hh, min] = (horaCita || '00:00').split(':');
      const hNum = parseInt(hh);
      const horaLegible = `${hNum > 12 ? hNum - 12 : hNum}:${min}${hNum < 12 ? 'am' : 'pm'}`;

      await addTag(contactId, 'escalado nhck');
      await humanDelay();
      await sendMessage(conversationId,
        `¡Perfecto ${nombre}! Tu cita queda agendada para el ${fechaLegible} a las ${horaLegible} 🎉\nEn un momento un asesor te confirmará los detalles finales 🙌`,
        contactId);
      return res.json({ success: true, citaConfirmada: true });
    }

    // ─── ESCALAR ─────────────────────────────────────────────────────────────
    if (reply.includes('[ESCALAR]')) {
      await addTag(contactId, 'escalado nhck');
      await humanDelay();
      await sendMessage(conversationId, 'En un momento un asesor del área de ventas te va a ayudar con esto 🙌', contactId);
      return res.json({ success: true, escalated: true });
    }

    // ─── RESPUESTA NORMAL ─────────────────────────────────────────────────────
    conversationHistory[conversationId].push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
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