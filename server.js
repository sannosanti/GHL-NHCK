const express = require('express');
const fetch = require('node-fetch');
const { Pool } = require('pg');
const crypto = require('crypto');
const app = express();
app.use(express.json());
app.use('/public', require('express').static('public')); // Archivos estáticos (QR, etc)

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GHL_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || '1000.YU4EF3FZ0RS8NAEMKVPVNTS7DU23WK';
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'fc1adeeb598f9a6a7d38912922bfffcb1db6857203';
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || '1000.18ea8055151efce1711489d0475df2c9.6533e8fc2ee705c2af94f5a108312d26';

const ID_CONSULTOR_JUAN_ESTEBAN = '3572150000004930155';
const ID_CONSULTOR_MAPEOS = '3572150000005140253';
const ID_ESPACIO_MAPEOS = '3572150000004871116';

const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY || 'pub_test_KXCXFRLYICPi7F2r1cjj4WMTXWkh3cXW';
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY || 'test_integrity_g9UQoEukIzFDreRn5yOX9mSZkE5jeauz';
const WOMPI_BASE_URL = 'https://sandbox.wompi.co/v1';

const GHL_PIPELINE_ID = 'GFfv1dCSQAAZ70MNHsfM';
const STAGE_INICIO = '24270da1-9917-4ba7-bf5a-35b226b2687f';
const STAGE_INFO_COMPLETA = '2c04e0ac-0429-4300-bf18-6f75cabe8953';
const STAGE_LINK_PAGO = '87c45501-386f-418e-95e7-6975b20559a6';
const STAGE_PAGO_PARCIAL = '18571c0c-5c8f-40f1-9440-e865670ac108';

const inactivityTimers = {};
const messageBuffers = {}; // Buffer para agrupar mensajes rápidos del mismo usuario

const HORARIOS_NHCK = {
  1: [{ ini: 14, fin: 15.5 }],
  2: [{ ini: 8.5, fin: 10.5 }, { ini: 13, fin: 16.5 }],
  3: [{ ini: 8.5, fin: 10.5 }, { ini: 13, fin: 15.5 }],
  4: [{ ini: 8.5, fin: 10.5 }, { ini: 13, fin: 16.5 }],
  5: [{ ini: 8.5, fin: 10.5 }, { ini: 13, fin: 15.5 }],
  6: [{ ini: 8.5, fin: 10.5 }]
};

const TRIAJE_P1 = ['Atención/concentración', 'Bajo rendimiento', 'Desregulación emocional', 'Conducta impulsiva', 'Ansiedad/inseguridad', 'Otro'];
const TRIAJE_P2 = ['Menos de 3 meses', '3 a 6 meses', '6 a 12 meses', 'Más de 1 año'];
const TRIAJE_P3 = ['Psicología', 'Neuropsicología', 'Apoyo escolar', 'Medicación', 'Varias sin resultado', 'Nada aún', 'Otro'];

// ─── POSTGRESQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      contact_id TEXT,
      phone TEXT,
      messages JSONB DEFAULT '[]',
      triaje JSONB DEFAULT '{}',
      estado TEXT DEFAULT 'nuevo',
      last_message_id TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pending_payments (
      referencia TEXT PRIMARY KEY,
      contact_id TEXT,
      conversation_id TEXT,
      contact_data JSONB,
      fecha_cita TEXT,
      hora_cita TEXT,
      edad TEXT,
      genero TEXT,
      ocupacion TEXT,
      sintoma TEXT,
      nombre_nino TEXT,
      nombre TEXT,
      payment_link_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS availability_cache (
      fecha_iso TEXT PRIMARY KEY,
      citas JSONB DEFAULT '[]',
      cached_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS contact_cache (
      contact_id TEXT PRIMARY KEY,
      contact_data JSONB,
      cached_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transaction_logs (
      id SERIAL PRIMARY KEY,
      contact_id TEXT,
      conversation_id TEXT,
      event_type TEXT,
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Migraciones seguras
  await pool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS nombre_nino TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS nombre TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS payment_link_id TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone TEXT`).catch(()=>{});
  console.log('Base de datos inicializada ✓');
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function getConversationData(conversationId) {
  try {
    const res = await pool.query('SELECT * FROM conversations WHERE conversation_id = $1', [conversationId]);
    return res.rows[0] || null;
  } catch { return null; }
}

async function saveConversationData(conversationId, contactId, messages, triaje, estado, lastMessageId, phone) {
  try {
    await pool.query(`
      INSERT INTO conversations (conversation_id, contact_id, phone, messages, triaje, estado, last_message_id, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (conversation_id) DO UPDATE
      SET messages=$4, triaje=$5, estado=$6, last_message_id=$7, phone=COALESCE($3, conversations.phone), updated_at=NOW()
    `, [conversationId, contactId, phone||null, JSON.stringify(messages), JSON.stringify(triaje), estado, lastMessageId]);
  } catch (err) { console.error('Error guardando conversación:', err.message); }
}

async function limpiarContactoDB(contactId) {
  try {
    await pool.query('DELETE FROM conversations WHERE contact_id = $1', [contactId]);
    await pool.query('DELETE FROM contact_cache WHERE contact_id = $1', [contactId]);
    await pool.query('DELETE FROM pending_payments WHERE contact_id = $1', [contactId]);
    console.log(`DB limpiada para contacto: ${contactId}`);
  } catch (err) { console.error('Error limpiando contacto DB:', err.message); }
}

async function limpiarConversacionDB(conversationId) {
  try {
    await pool.query('DELETE FROM conversations WHERE conversation_id = $1', [conversationId]);
    console.log(`DB limpiada para conversación: ${conversationId}`);
  } catch (err) { console.error('Error limpiando conversación DB:', err.message); }
}

async function getCachedContact(contactId) {
  try {
    const res = await pool.query(
      "SELECT contact_data FROM contact_cache WHERE contact_id=$1 AND cached_at > NOW() - INTERVAL '5 minutes'",
      [contactId]
    );
    return res.rows[0]?.contact_data || null;
  } catch { return null; }
}

async function setCachedContact(contactId, contactData) {
  try {
    await pool.query(`
      INSERT INTO contact_cache (contact_id, contact_data, cached_at) VALUES ($1,$2,NOW())
      ON CONFLICT (contact_id) DO UPDATE SET contact_data=$2, cached_at=NOW()
    `, [contactId, JSON.stringify(contactData)]);
  } catch (err) { console.error('Error cacheando contacto:', err.message); }
}

async function savePendingPayment(referencia, datos) {
  try {
    await pool.query(`
      INSERT INTO pending_payments (referencia,contact_id,conversation_id,contact_data,fecha_cita,hora_cita,edad,genero,ocupacion,sintoma,nombre_nino,nombre,payment_link_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (referencia) DO UPDATE SET fecha_cita=$5, hora_cita=$6, payment_link_id=$13
    `, [referencia, datos.contactId, datos.conversationId, JSON.stringify(datos.contact),
        datos.fechaCita, datos.horaCita, datos.edad, datos.genero, datos.ocupacion,
        datos.sintoma, datos.nombreNino, datos.nombre, datos.paymentLinkId || null]);
  } catch (err) { console.error('Error guardando pago:', err.message); }
}

async function getPendingPayment(reference) {
  try {
    let res = await pool.query('SELECT * FROM pending_payments WHERE referencia=$1', [reference]);
    if (!res.rows[0]) {
      const linkId = reference.split('_').slice(0, 2).join('_');
      res = await pool.query('SELECT * FROM pending_payments WHERE payment_link_id=$1', [linkId]);
    }
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return { contactId: r.contact_id, conversationId: r.conversation_id, contact: r.contact_data,
             fechaCita: r.fecha_cita, horaCita: r.hora_cita, edad: r.edad, genero: r.genero,
             ocupacion: r.ocupacion, sintoma: r.sintoma, nombreNino: r.nombre_nino, nombre: r.nombre };
  } catch { return null; }
}

async function deletePendingPayment(referencia) {
  try { await pool.query('DELETE FROM pending_payments WHERE referencia=$1', [referencia]); }
  catch (err) { console.error('Error borrando pago:', err.message); }
}

async function getCachedDisponibilidad(fechaISO) {
  try {
    const res = await pool.query(
      "SELECT citas FROM availability_cache WHERE fecha_iso=$1 AND cached_at > NOW() - INTERVAL '10 minutes'",
      [fechaISO]
    );
    return res.rows[0]?.citas || null;
  } catch { return null; }
}

async function setCachedDisponibilidad(fechaISO, citas) {
  try {
    await pool.query(`
      INSERT INTO availability_cache (fecha_iso, citas, cached_at) VALUES ($1,$2,NOW())
      ON CONFLICT (fecha_iso) DO UPDATE SET citas=$2, cached_at=NOW()
    `, [fechaISO, JSON.stringify(citas)]);
  } catch (err) { console.error('Error guardando caché:', err.message); }
}

async function logEvent(contactId, conversationId, eventType, data) {
  try {
    await pool.query(
      'INSERT INTO transaction_logs (contact_id,conversation_id,event_type,data) VALUES ($1,$2,$3,$4)',
      [contactId, conversationId, eventType, JSON.stringify(data)]
    );
  } catch (err) { console.error('Error log:', err.message); }
}

// ─── ZOHO TOKEN ───────────────────────────────────────────────────────────────
let zohoAccessToken = null;
let zohoTokenExpiry = 0;

async function getZohoAccessToken() {
  if (zohoAccessToken && Date.now() < zohoTokenExpiry) return zohoAccessToken;
  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'refresh_token', client_id:ZOHO_CLIENT_ID,
      client_secret:ZOHO_CLIENT_SECRET, refresh_token:ZOHO_REFRESH_TOKEN })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('No token Zoho: ' + JSON.stringify(data));
  zohoAccessToken = data.access_token;
  zohoTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log('Token Zoho renovado');
  return zohoAccessToken;
}

// ─── MAPEOS ───────────────────────────────────────────────────────────────────
function mapearSintoma(s) {
  s = (s || '').toLowerCase().trim();
  if (s.includes('ansiedad') || s.includes('miedo') || s.includes('inseguridad')) return 'Ansiedad';
  if (s.includes('autis')) return 'Autismo';
  if (s.includes('autoestima') || s.includes('confianza')) return 'Autoestima';
  if (s.includes('deficit') || s.includes('déficit') || s.includes('atención') || s.includes('atencion') || s.includes('tdah') || s.includes('concentra')) return 'Déficit de atención';
  if (s.includes('depres')) return 'Depresión1';
  if (s.includes('rendimiento') || s.includes('aprendizaje') || s.includes('escolar') || s.includes('dislexia')) return 'Dificultades de aprendizaje';
  if (s.includes('desregul') || s.includes('emocional')) return 'Ansiedad';
  if (s.includes('conduct') || s.includes('impulsiv')) return 'TOD (Transtorno Oposicion...)';
  if (s.includes('estrés') || s.includes('estres')) return 'Estrés';
  if (s.includes('toc') || s.includes('obsesiv')) return 'TOC (Transtorno Obsesivo C...)';
  return 'Otros';
}

function mapearGenero(g) {
  g = (g || '').toLowerCase().trim();
  if (g.includes('mascul') || g.includes('niño') || g.includes('hombre') || g === 'm') return 'Masculino';
  if (g.includes('femen') || g.includes('niña') || g.includes('mujer') || g === 'f') return 'Femenino';
  return 'Otro';
}

function mapearOcupacionNino(estudia) {
  return (estudia === true || estudia === 'si' || estudia === 'sí') ? 'Estudiante de colegio' : 'N.A';
}

// ─── GHL: GUARDAR CAMPOS NIÑO ─────────────────────────────────────────────────
async function guardarCamposNinoGHL(contactId, { nombreNino, edadNino, generoNino, estudia, sintoma }) {
  try {
    const customFields = [
      { id: 'nhck__nombre_del_nio', value: nombreNino || '' },
      { id: 'nhck__edad_del_nio', value: edadNino || '' },
      { id: 'nhck__gnero_del_nio', value: mapearGenero(generoNino) },
      { id: 'nhck__estudia', value: estudia ? 'Sí' : 'No' },
      { id: 'nhck__sntoma_principal', value: mapearSintoma(sintoma) }
    ];
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields })
    });
    await pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(()=>{});
    console.log('Campos niño guardados en GHL');
  } catch (err) { console.error('Error guardando campos niño GHL:', err.message); }
}

// ─── ZOHO ANAMNESIS ───────────────────────────────────────────────────────────
async function buscarContactoAnamnesis(movil, email) {
  try {
    const token = await getZohoAccessToken();
    const movilLimpio = (movil || '').replace(/[\s+\(\)\-]/g, '');
    const variantes = [movilLimpio];
    if (movilLimpio.startsWith('57') && movilLimpio.length === 12) variantes.push(movilLimpio.slice(2));
    if (!movilLimpio.startsWith('57') && movilLimpio.length === 10) variantes.push('57' + movilLimpio);
    for (const tel of variantes) {
      const res = await fetch(
        `https://creator.zoho.com/api/v2/visionintegralceo/v2/report/Contactos_Report?criteria=Movil%3D%22${tel}%22&max_records=1`,
        { headers: { 'Authorization': `Zoho-oauthtoken ${token}` } }
      );
      const data = await res.json();
      if (data?.data?.length > 0) { console.log('Contacto existente:', data.data[0].ID); return data.data[0].ID; }
    }
    if (email) {
      const res = await fetch(
        `https://creator.zoho.com/api/v2/visionintegralceo/v2/report/Contactos_Report?criteria=Email%3D%22${encodeURIComponent(email)}%22&max_records=1`,
        { headers: { 'Authorization': `Zoho-oauthtoken ${token}` } }
      );
      const data = await res.json();
      if (data?.data?.length > 0) { console.log('Contacto existente por email:', data.data[0].ID); return data.data[0].ID; }
    }
    return null;
  } catch (err) { console.error('Error buscando contacto:', err.message); return null; }
}

async function crearEnAnamnesis({ nombreNino, email, movil, contactIdGHL, edad, sintoma, genero, estudia }) {
  const token = await getZohoAccessToken();
  const headers = { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
  const movilLimpio = (movil || '').replace(/[\s+\(\)\-]/g, '');
  const ocupacion = mapearOcupacionNino(estudia);
  let contactoID = await buscarContactoAnamnesis(movilLimpio, email);
  if (!contactoID) {
    const res = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/v2/form/Contactos', {
      method: 'POST', headers,
      body: JSON.stringify({ data: {
        Nombre_Completo: nombreNino || '', Email: email || '', Movil: movilLimpio,
        CRM: contactIdGHL || '', Edad: edad || '', Sintoma_o_necesidad: mapearSintoma(sintoma),
        Genero: mapearGenero(genero), Ocupaci_n: ocupacion
      }})
    });
    const data = await res.json();
    console.log('ZOHO CONTACTO:', JSON.stringify(data));
    contactoID = data?.data?.ID;
    if (!contactoID) throw new Error('No ID contacto: ' + JSON.stringify(data));
  }
  const resProceso = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/v2/form/Procesos', {
    method: 'POST', headers,
    body: JSON.stringify({ data: {
      Nombrel_del_consultante: contactoID, Edad: edad || '',
      S_ntoma: mapearSintoma(sintoma), Genero: mapearGenero(genero),
      Ocupaci_n: ocupacion, Tipo_Proceso: 'Diagnóstico', Estado_Paciente: 'Activo'
    }})
  });
  const dataProceso = await resProceso.json();
  console.log('ZOHO PROCESO:', JSON.stringify(dataProceso));
  return { contactoID, dataProceso };
}

// ─── ZOHO CALENDARIO ──────────────────────────────────────────────────────────
async function crearCitasCalendario({ movil, email, fechaISO, horaInicio, contactoID, nombreNino }) {
  const token = await getZohoAccessToken();
  const headers = { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
  let hIni, mIni;
  if (typeof horaInicio === 'string' && horaInicio.includes(':')) {
    [hIni, mIni] = horaInicio.split(':').map(Number);
  } else { hIni = Math.floor(horaInicio); mIni = (horaInicio % 1) * 60; }
  const meses = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(fechaISO + 'T00:00:00');
  const dd = String(d.getDate()).padStart(2,'0');
  const mmm = meses[d.getMonth()];
  const yyyy = d.getFullYear();
  const pad = n => String(n).padStart(2,'0');
  const fmt = (h,m) => `${dd}-${mmm}-${yyyy} ${pad(h)}:${pad(m)}:00`;
  const diaStr = `${dd}-${mmm}-${yyyy}`;
  const fin1H = mIni+30>=60 ? hIni+1 : hIni; const fin1M = (mIni+30)%60;
  const ini2H = fin1H; const ini2M = fin1M;
  const fin2H = ini2M+60>=60 ? ini2H+1 : ini2H; const fin2M = (ini2M+60)%60;
  const base = { Tipo:'Presencial', Contacto: contactoID||'', Email: email||'',
    Estado:'Programada', Observaciones:'NHC Kids - Agendado por Carolina IA', Dia: diaStr, Nombre: nombreNino || '' };
  const res1 = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/calendario/form/Citas', {
    method:'POST', headers, body: JSON.stringify({ data: { ...base,
      Inicio: fmt(hIni,mIni), Fin: fmt(fin1H,fin1M), Duraci_n:'30 minutos',
      Consultor: ID_CONSULTOR_JUAN_ESTEBAN, Espacio: '3572150000004826074'
    }})
  });
  const data1 = await res1.json(); console.log('CITA 1 PRE:', JSON.stringify(data1));
  const res2 = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/calendario/form/Citas', {
    method:'POST', headers, body: JSON.stringify({ data: { ...base,
      Inicio: fmt(ini2H,ini2M), Fin: fmt(fin2H,fin2M), Duraci_n:'1 hora',
      Consultor: ID_CONSULTOR_MAPEOS, Espacio: ID_ESPACIO_MAPEOS
    }})
  });
  const data2 = await res2.json(); console.log('CITA 2 NEUROMAPEO:', JSON.stringify(data2));
  return { cita1: data1, cita2: data2 };
}

// ─── DISPONIBILIDAD ───────────────────────────────────────────────────────────
async function getDisponibilidad(fechaISO) {
  try {
    const token = await getZohoAccessToken();
    const criteria = `(Inicio >= "${fechaISO} 00:00:00" && Inicio <= "${fechaISO} 23:59:59")`;
    const url = `https://creator.zoho.com/api/v2/visionintegralceo/calendario/report/Citas_Report?criteria=${encodeURIComponent(criteria)}&max_records=50`;
    const res = await fetch(url, { headers: { 'Authorization': `Zoho-oauthtoken ${token}` } });
    const data = await res.json();
    return data.data || [];
  } catch (err) { console.error('Error disponibilidad:', err.message); return []; }
}

function calcularSlotsLibres(citas, fechaISO) {
  const fecha = new Date(fechaISO + 'T00:00:00');
  const dia = fecha.getDay();
  const horarios = HORARIOS_NHCK[dia];
  if (!horarios) return [];
  const ocupadosJE = [], ocupadosMapeos = [];
  citas.forEach(c => {
    const cID = c.Consultor?.ID || '';
    const tIni = new Date((c.Inicio || '').replace(/-/g,' '));
    const tFin = new Date((c.Fin || '').replace(/-/g,' '));
    if (isNaN(tIni)) return;
    const hIni = tIni.getHours() + tIni.getMinutes()/60;
    const hFin = isNaN(tFin) ? hIni + 0.5 : tFin.getHours() + tFin.getMinutes()/60;
    if (cID === ID_CONSULTOR_JUAN_ESTEBAN) ocupadosJE.push({ ini: hIni, fin: hFin });
    if (cID === ID_CONSULTOR_MAPEOS) ocupadosMapeos.push({ ini: hIni, fin: hFin });
  });
  const slots = [];
  for (const { ini, fin } of horarios) {
    for (let h = ini; h + 1.5 <= fin; h += 0.5) {
      const jeLibre = !ocupadosJE.some(o => o.ini < h + 0.5 && o.fin > h);
      const mapeosLibre = !ocupadosMapeos.some(o => o.ini < h + 1.5 && o.fin > h + 0.5);
      if (jeLibre && mapeosLibre) {
        const hh = Math.floor(h); const mm = (h%1)*60;
        const hh12 = hh > 12 ? hh-12 : hh === 0 ? 12 : hh;
        slots.push({ label:`${hh12}:${mm===0?'00':'30'}${hh<12?'am':'pm'}`, horaISO:`${String(hh).padStart(2,'0')}:${mm===0?'00':'30'}` });
      }
    }
  }
  return slots;
}

// ─── WOMPI ────────────────────────────────────────────────────────────────────
async function generarLinkPago({ referencia, monto, nombre, email, telefono }) {
  const montoEnCentavos = monto * 100;
  const cadena = `${referencia}${montoEnCentavos}COP${WOMPI_INTEGRITY_KEY}`;
  const firma = crypto.createHash('sha256').update(cadena).digest('hex');
  const res = await fetch(`${WOMPI_BASE_URL}/payment_links`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.WOMPI_PRIVATE_KEY || 'prv_test_rs7u6wx1045DshLEx7tLz58YAe6XOmwn'}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Reserva NHC Kids - Neuromapeo', description: 'Reserva para el proceso de Neuromapeo Kids ($100.000)',
      single_use: true, collect_shipping: false, currency: 'COP', amount_in_cents: montoEnCentavos,
      reference: referencia, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      redirect_url: 'https://miraculous-solace-production-47dd.up.railway.app/pago-exitoso',
      signature: { integrity: firma },
      customer_data: { customer_name: nombre||'', customer_last_name:'', customer_legal_id:'',
        customer_legal_id_type:'CC', customer_email: email||'',
        customer_phone: (telefono||'').replace(/[\s+\(\)\-]/g,'') }
    })
  });
  const data = await res.json();
  console.log('WOMPI PAYMENT LINK:', JSON.stringify(data));
  if (data?.data?.id) return { url: `https://checkout.wompi.co/l/${data.data.id}`, linkId: data.data.id };
  const params = new URLSearchParams({
    'public-key': WOMPI_PUBLIC_KEY, currency:'COP', 'amount-in-cents': montoEnCentavos, reference: referencia,
    'signature:integrity': firma, 'customer-data:email': email||'', 'customer-data:full-name': nombre||'',
    'customer-data:phone-number': (telefono||'').replace(/[\s+\(\)\-]/g,''),
    'redirect-url': 'https://miraculous-solace-production-47dd.up.railway.app/pago-exitoso'
  });
  return { url: `https://checkout.wompi.co/p/?${params.toString()}`, linkId: null };
}

// ─── OPORTUNIDADES GHL ────────────────────────────────────────────────────────
async function crearOportunidad(contactId, nombre, stageId) {
  try {
    const res = await fetch('https://services.leadconnectorhq.com/opportunities/', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineId: GHL_PIPELINE_ID, locationId: GHL_LOCATION_ID,
        name: `NHC Kids - ${nombre}`, pipelineStageId: stageId, status: 'open', contactId })
    });
    const data = await res.json();
    console.log('OPORTUNIDAD CREADA:', JSON.stringify(data));
    return data.opportunity?.id || null;
  } catch (err) { console.error('Error creando oportunidad:', err.message); return null; }
}

async function actualizarEtapaOportunidad(contactId, stageId) {
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${GHL_PIPELINE_ID}&contact_id=${contactId}`, {
      headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-07-28' }
    });
    const data = await res.json();
    const opp = data.opportunities?.[0];
    if (!opp) return null;
    const resUpdate = await fetch(`https://services.leadconnectorhq.com/opportunities/${opp.id}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipelineStageId: stageId })
    });
    const dataUpdate = await resUpdate.json();
    console.log('ETAPA ACTUALIZADA:', JSON.stringify(dataUpdate));
    return opp.id;
  } catch (err) { console.error('Error actualizando etapa:', err.message); return null; }
}

// ─── INACTIVIDAD ──────────────────────────────────────────────────────────────
function limpiarTimers(conversationId) {
  if (inactivityTimers[conversationId]) {
    clearTimeout(inactivityTimers[conversationId].timer5);
    clearTimeout(inactivityTimers[conversationId].timer10);
    delete inactivityTimers[conversationId];
  }
}

function iniciarTimersInactividad(conversationId, contactId) {
  limpiarTimers(conversationId);
  inactivityTimers[conversationId] = {
    timer5: setTimeout(async () => {
      try { await sendMessage(conversationId, '¿Sigues por ahí? 😊 Quedo pendiente por si tienes alguna duda.', contactId); }
      catch (err) { console.error('Error timer 5min:', err.message); }
    }, 5 * 60 * 1000),
    timer10: setTimeout(async () => {
      try { await sendMessage(conversationId, 'Por ahora cerramos la conversación pero quedamos atentos 🙌\nCuando quieras retomar el proceso nos escribes y con gusto te ayudamos.', contactId); }
      catch (err) { console.error('Error timer 10min:', err.message); }
    }, 10 * 60 * 1000)
  };
}

// ─── GHL HELPERS ──────────────────────────────────────────────────────────────
const humanDelay = () => new Promise(r => setTimeout(r, Math.floor(Math.random()*4000)+2000));

async function getContact(contactId) {
  const cached = await getCachedContact(contactId);
  if (cached) return { contact: cached };
  const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15' }
  });
  if (res.status === 404) return { contact: null, deleted: true };
  const data = await res.json();
  if (data.contact) await setCachedContact(contactId, data.contact);
  return data;
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
    if (!Array.isArray(messages) || messages.length === 0) return { body:'', id:null };
    const last = messages.find(m => m.direction === 'inbound') || messages[0];
    return { body: last?.body||'', id: last?.id||null };
  } catch (err) { return { body:'', id:null }; }
}

async function addTag(contactId, tag) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [tag] })
  });
  await pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(()=>{});
}

async function removeTag(contactId, tag) {
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [tag] })
  });
  await pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(()=>{});
}

async function sendMessage(conversationId, message, contactId) {
  const res = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type:'WhatsApp', conversationId, contactId, message })
  });
  const data = await res.json();
  console.log('SEND MSG:', JSON.stringify(data));
}

async function sendImage(conversationId, contactId, imageUrl, caption) {
  try {
    // Intentar con attachments como array de objetos
    const res = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'WhatsApp',
        conversationId,
        contactId,
        attachments: [{ url: imageUrl, type: 'image/jpeg' }],
        message: caption || ''
      })
    });
    const data = await res.json();
    console.log('SEND IMG:', JSON.stringify(data));
  } catch(err) { console.error('Error enviando imagen:', err.message); }
}

async function sendMessages(conversationId, messages, contactId) {
  for (let i = 0; i < messages.length; i++) {
    await sendMessage(conversationId, messages[i], contactId);
    if (i < messages.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
}

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Servidor NHC Kids activo ✓'));

app.get('/reset/:conversationId', async (req, res) => {
  try {
    await pool.query('DELETE FROM conversations WHERE conversation_id=$1', [req.params.conversationId]);
    res.send(`✓ Conversación ${req.params.conversationId} reiniciada`);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.get('/reset-contact/:contactId', async (req, res) => {
  try {
    await limpiarContactoDB(req.params.contactId);
    res.send(`✓ Contacto ${req.params.contactId} reiniciado`);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ─── WEBHOOK: CONTACTO ELIMINADO EN GHL ──────────────────────────────────────
// Configurar en GHL → Configuración → Webhooks → Evento: ContactDeleted
// URL: https://miraculous-solace-production-47dd.up.railway.app/webhook/contact-deleted
app.post('/webhook/contact-deleted', async (req, res) => {
  try {
    console.log('CONTACT DELETED WEBHOOK:', JSON.stringify(req.body));

    // GHL puede enviar el ID en distintos campos según la versión del webhook
    const contactId =
      req.body.id ||
      req.body.contactId ||
      req.body.contact?.id ||
      req.body.customData?.contactId ||
      req.body.contact_id;

    if (!contactId) {
      console.log('Contact-deleted sin contactId:', JSON.stringify(req.body));
      return res.json({ ok: false, reason: 'no contactId' });
    }

    await limpiarContactoDB(contactId);
    console.log(`Contacto ${contactId} eliminado de GHL → DB limpiada`);
    res.json({ ok: true, contactId });
  } catch (err) {
    console.error('Error webhook contact-deleted:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── BUFFER DE MENSAJES ──────────────────────────────────────────────────────
// Acumula mensajes del mismo contacto en una ventana de 3 segundos
function bufferMessage(contactId, message, callback) {
  if (messageBuffers[contactId]) {
    // Ya hay un buffer activo — acumular mensaje y reiniciar timer
    if (message && message.trim()) {
      messageBuffers[contactId].messages.push(message.trim());
    }
    clearTimeout(messageBuffers[contactId].timer);
  } else {
    // Nuevo buffer
    messageBuffers[contactId] = {
      messages: message && message.trim() ? [message.trim()] : [],
      callback: callback
    };
  }

  // Timer: procesar después de 3 segundos sin nuevos mensajes
  messageBuffers[contactId].timer = setTimeout(() => {
    const buffered = messageBuffers[contactId];
    delete messageBuffers[contactId];
    const combinedMessage = buffered.messages.join(' ');
    buffered.callback(combinedMessage);
  }, 3000);
}

// ─── ANÁLISIS DE COMPROBANTE CON CLAUDE VISION ───────────────────────────────
async function analizarComprobante(imageUrl) {
  try {
    // Descargar imagen y convertir a base64
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error('No se pudo descargar imagen: ' + imgRes.status);
    const buffer = await imgRes.buffer();
    const base64 = buffer.toString('base64');
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: contentType, data: base64 }
            },
            {
              type: 'text',
              text: `Analiza este comprobante de pago. Responde SOLO en JSON con este formato exacto:
{
  "es_comprobante": true/false,
  "monto": <número o null>,
  "destinatario": "<texto o null>",
  "aprobado": true/false,
  "motivo": "<razón breve>"
}

Criterios para aprobado=true:
- Es un comprobante/recibo de transferencia o pago
- El monto es entre 80000 y 120000 (pesos colombianos, acepta variaciones)
- El destinatario menciona: Visión Integral, NHC, Neurohacking, Wompi, o similar

Si no cumple algún criterio, aprobado=false y explica en motivo.`
            }
          ]
        }]
      })
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    console.log('ANÁLISIS COMPROBANTE:', JSON.stringify(result));
    return result;
  } catch (err) {
    console.error('Error analizando comprobante:', err.message);
    return { es_comprobante: false, aprobado: false, motivo: 'Error al analizar imagen' };
  }
}

// ─── WEBHOOK GHL (mensajes WhatsApp) ─────────────────────────────────────────
app.post('/webhook/ghl', async (req, res) => {
  res.json({ success: true, received: true }); // Responder inmediatamente a GHL

  try {
    const contactId = req.body.contactId || req.body.customData?.contactId || req.body.contact_id || req.body.contact?.id;
    if (!contactId) return;

    let conversationId = req.body.conversationId || req.body.customData?.conversationId || '';
    let messageBody = req.body.message?.body || req.body.customData?.message || '';
    const messageId = req.body.message?.id || req.body.customData?.messageId || null;
    const messageType = String(req.body.customData?.messageType || req.body.message?.type || req.body.type || '');
    const imageUrl = req.body.customData?.attachments || null;
    const isImage = messageType === '19' || messageType === 'IMAGE' || !!imageUrl;

    // ─── BUFFER ANTI-MULTI-MENSAJE ────────────────────────────────────────────
    if (!isImage && messageBody && messageBody.trim()) {
      if (messageBuffers[contactId]) {
        // Ya hay buffer — acumular y salir (el primero procesará todo)
        messageBuffers[contactId].push(messageBody.trim());
        console.log(`BUFFER: acumulado "${messageBody.trim()}" para ${contactId}`);
        return;
      } else {
        // Primer mensaje — crear buffer y esperar 3s
        messageBuffers[contactId] = [messageBody.trim()];
        await new Promise(r => setTimeout(r, 3000));
        const buffered = messageBuffers[contactId] || [messageBody.trim()];
        delete messageBuffers[contactId];
        messageBody = buffered.join(' ');
        if (buffered.length > 1) console.log(`BUFFER: combinado "${messageBody}"`);
      }
    }

    if (!conversationId) {
      // GHL a veces tarda en crear la conversación — reintentar hasta 3 veces
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 2000));
        conversationId = await getConversationId(contactId);
        if (conversationId) break;
        console.log(`Reintento ${i+1}/3 buscando conversación para ${contactId}`);
      }
    }
    if (!conversationId) return res.status(400).json({ error: 'No conversación' });

    // Deduplicación
    const convData = await getConversationData(conversationId);
    if (messageId && convData?.last_message_id === messageId) {
      console.log('Mensaje duplicado, saltando:', messageId);
      // ya respondido: return res.json({ success: true, skipped: true, reason: 'duplicate' }); return;
    }

    limpiarTimers(conversationId);

    const contactData = await getContact(contactId);

    // Contacto eliminado en GHL — limpiar DB y dejar que GHL lo recree
    if (contactData.deleted) {
      console.log(`Contacto ${contactId} no existe en GHL (404) — limpiando DB`);
      await limpiarContactoDB(contactId);
      // ya respondido: return res.json({ success: true, skipped: true, reason: 'contact_deleted' }); return;
    }

    const contact = contactData.contact || {};
    const tags = contact.tags || [];

    if (tags.includes('escalado nhck')) {
      // ya respondido: return res.json({ success: true, skipped: true, reason: 'escalado' }); return;
    }

    let lastMsg = messageBody;
    let lastMsgId = messageId;
    if (!lastMsg) {
      const fetched = await getLastMessage(conversationId);
      lastMsg = fetched.body;
      lastMsgId = fetched.id;
    }
    if (!lastMsg) // ya respondido: return res.json({ success: true, skipped: true }); return;

    // ─── MANEJO DE IMAGEN ────────────────────────────────────────────────────────
    if (isImage && imageUrl && estado === 'esperando_pago') {
      console.log('IMAGEN RECIBIDA en esperando_pago:', imageUrl);
      await humanDelay();

      const analisis = await analizarComprobante(imageUrl);

      if (analisis.aprobado) {
        // Comprobante válido — confirmar igual que Wompi
        const pending = await pool.query(
          'SELECT * FROM pending_payments WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1',
          [contactId]
        );
        const pago = pending.rows[0];

        if (pago) {
          const mesesN = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
          const [,mm,dd] = (pago.fecha_cita||'').split('-');
          const fechaL = pago.fecha_cita ? `${parseInt(dd)} de ${mesesN[parseInt(mm)-1]}` : 'la fecha acordada';
          const [hh,min] = (pago.hora_cita||'00:00').split(':');
          const hN = parseInt(hh);
          const horaL = `${hN>12?hN-12:hN===0?12:hN}:${min}${hN<12?'am':'pm'}`;
          const nombrePago = pago.nombre || nombre;

          // Crear en Anamnesis y Zoho Calendario
          let resultado = null;
          try {
            resultado = await crearEnAnamnesis({
              nombreNino: pago.nombre_nino||contact.firstName||'',
              email: contact.email||'', movil: contact.phone||'', contactIdGHL: contactId,
              edad: pago.edad, sintoma: pago.sintoma, genero: pago.genero,
              estudia: pago.ocupacion === 'Estudiante de colegio'
            });
          } catch(err) { console.error('Error Anamnesis comprobante:', err.message); }

          try {
            await crearCitasCalendario({
              movil: contact.phone||'', email: contact.email||'',
              fechaISO: pago.fecha_cita, horaInicio: pago.hora_cita,
              contactoID: resultado?.contactoID||null, nombreNino: pago.nombre_nino||''
            });
            await pool.query('DELETE FROM availability_cache WHERE fecha_iso=$1', [pago.fecha_cita]).catch(()=>{});
          } catch(err) { console.error('Error Citas comprobante:', err.message); }

          await addTag(contactId, 'escalado nhck');
          await addTag(contactId, 'pagó 100K nhck');
          await deletePendingPayment(pago.referencia);
          actualizarEtapaOportunidad(contactId, STAGE_PAGO_PARCIAL).catch(()=>{});
          limpiarTimers(conversationId);
          await logEvent(contactId, conversationId, 'pago_comprobante_aprobado', { imageUrl, analisis });

          await saveConversationData(conversationId, contactId, history, triaje, 'escalado', lastMsgId, phone);
          await sendMessages(conversationId, [
            `✅ ¡Comprobante recibido ${nombrePago}! Tu cita está confirmada para el ${fechaL} a las ${horaL} 🎉`,
            `Recuerda llegar 10 minutos antes. ¡Nos vemos pronto! 🙌`,
            `En breve uno de nuestros asesores te escribirá para coordinar los últimos detalles: ubicación del centro, test previo y recomendaciones para el proceso. 🙏`
          ], contactId);
        } else {
          await sendMessage(conversationId, '✅ ¡Comprobante recibido! Un asesor confirmará tu cita en breve. 🙌', contactId);
        }
      } else {
        // Comprobante inválido o no es comprobante
        const motivo = analisis.es_comprobante
          ? `El monto o destinatario no corresponde (${analisis.motivo})`
          : 'La imagen no parece ser un comprobante de pago';
        await sendMessages(conversationId, [
          `Hmm, no pude verificar el pago con esa imagen 🤔`,
          `${motivo}. ¿Puedes enviar el comprobante de la transferencia de $100.000 a NHC Kids? También puedes pagar directamente en el link que te envié 👇`
        ], contactId);
        await logEvent(contactId, conversationId, 'comprobante_rechazado', { imageUrl, analisis });
      }

      // ya respondido: return res.json({ success: true, imagen: true, aprobado: analisis.aprobado }); return;
    }

    // Si llega imagen en otro estado, ignorar silenciosamente
    if (isImage && imageUrl) {
      // ya respondido: return res.json({ success: true, skipped: true, reason: 'imagen_en_estado_no_aplica' }); return;
    }

    // Comando reset
    if (lastMsg.trim().toLowerCase() === '/reset') {
      await limpiarContactoDB(contactId);
      await removeTag(contactId, 'escalado nhck');
      await sendMessage(conversationId, '✓ Conversación reiniciada', contactId);
      // ya respondido: return res.json({ success: true, reset: true }); return;
    }

    const nombre = contact.firstName || 'Hola';
    const phone = contact.phone || '';

    // Si es contacto nuevo (sin historial en esta conversación), limpiar registros
    // viejos que puedan existir con el mismo número de teléfono (contacto recreado en GHL)
    if (!convData && phone) {
      try {
        const resViejos = await pool.query(
          'SELECT conversation_id, contact_id FROM conversations WHERE phone = $1 AND contact_id != $2',
          [phone, contactId]
        );
        if (resViejos.rows.length > 0) {
          console.log(`Limpiando ${resViejos.rows.length} registro(s) viejos para teléfono ${phone}`);
          for (const row of resViejos.rows) {
            await pool.query('DELETE FROM conversations WHERE conversation_id = $1', [row.conversation_id]);
            await pool.query('DELETE FROM contact_cache WHERE contact_id = $1', [row.contact_id]);
            await pool.query('DELETE FROM pending_payments WHERE contact_id = $1', [row.contact_id]);
          }
        }
      } catch (err) {
        console.error('Error limpiando registros viejos por teléfono:', err.message);
      }
    }

    const estado = convData?.estado || 'nuevo';
    const triaje = convData?.triaje || {};
    let history = convData?.messages || [];

    console.log('ESTADO:', estado, '| CONTACTO:', nombre);

    if (!convData) {
      crearOportunidad(contactId, `${contact.firstName||''} ${contact.lastName||''}`.trim(), STAGE_INICIO).catch(()=>{});
    }

    history.push({ role:'user', content:[{ type:'text', text:lastMsg }] });
    if (history.length > 20) history = history.slice(-20);

    // ─── DISPONIBILIDAD ───────────────────────────────────────────────────────
    let disponibilidadTexto = '';
    if (estado === 'agendando' || estado === 'triaje_completo') {
      try {
        const hoy = new Date();
        const mesesN = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
        const diasN = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
        let offset = 1, diasOk = 0;
        while (diasOk < 3 && offset <= 14) {
          const f = new Date(hoy); f.setDate(hoy.getDate()+offset);
          const ds = f.getDay();
          if (HORARIOS_NHCK[ds]) {
            const fISO = f.toISOString().split('T')[0];
            let citas = await getCachedDisponibilidad(fISO);
            if (!citas) { citas = await getDisponibilidad(fISO); await setCachedDisponibilidad(fISO, citas); }
            const slots = calcularSlotsLibres(citas, fISO);
            if (slots.length > 0) {
              disponibilidadTexto += `${diasN[ds]} ${f.getDate()} de ${mesesN[f.getMonth()]} (${fISO}): ${slots.slice(0,4).map(s=>s.label).join(', ')}\n`;
              diasOk++;
            }
          }
          offset++;
        }
        if (!disponibilidadTexto) disponibilidadTexto = 'Sin disponibilidad próximos días.';
      } catch (err) {
        disponibilidadTexto = 'No consultada. Intenta más tarde.';
      }
    }

    // ─── SYSTEM PROMPT SEGÚN ESTADO ───────────────────────────────────────────
    let systemPrompt = '';

    if (estado === 'nuevo') {
      systemPrompt = `Eres Carolina, asesora de NHC Kids. Escribes por WhatsApp — cálida, cercana, humana.

REGLAS DE FORMATO:
- Máximo 3 líneas por mensaje
- Si necesitas decir más, separa con ---
- Sin asteriscos ni negritas
- Tono conversacional

CONTEXTO:
- Alguien acaba de escribir por primera vez
- Eres la primera persona que responde
- NHC Kids aplica neurotecnologías para la salud mental de niños

TU TAREA:
1. Saluda cálidamente
2. Preséntate como Carolina de NHC Kids
3. Menciona en un mensaje breve que al continuar la conversación la persona acepta nuestras políticas de privacidad disponibles en https://neurohackingcenter.co/politicas-de-privacidad/
4. Pregunta: "¿Con quién tengo el gusto de hablar?"

Cuando responda con su nombre, incluye al final:
[NOMBRE_PADRE: <nombre que dijo>]

ESCALADO — SOLO con [ESCALAR] si pide explícitamente hablar con humano.
NUNCA digas que eres IA. Solo español.`;

    } else if (estado === 'triaje_p1') {
      systemPrompt = `Eres Carolina, asesora de NHC Kids. Escribes por WhatsApp — cálida, cercana, humana.

REGLAS DE FORMATO:
- Máximo 3 líneas por mensaje
- Si necesitas decir más, separa con ---
- Sin asteriscos ni negritas
- Tono conversacional

CONTEXTO:
- Hablas con ${nombre}
- NHC Kids aplica neurotecnologías para la salud mental de niños

TU TAREA:
IMPORTANTE: Lee TODO el historial de la conversación. Si el padre YA mencionó la dificultad o el tiempo en mensajes anteriores, NO vuelvas a preguntarlo — extrae la respuesta directamente de lo que ya dijo.

Haz la PRIMERA PREGUNTA del triaje de forma conversacional:
"¿Cuál es la principal dificultad que están observando en su hijo/a en este momento?"
Opciones: Atención/concentración, Bajo rendimiento, Desregulación emocional, Conducta impulsiva, Ansiedad/inseguridad, Otro

Si el padre ya respondió P1, interpreta y mapea, luego haz la SEGUNDA PREGUNTA:
"¿Hace cuánto tiempo vienen observando esta situación?"
Opciones: Menos de 3 meses, 3 a 6 meses, 6 a 12 meses, Más de 1 año

Si el padre ya respondió P2 también (por ejemplo dijo "hace 3 meses"), mapea ambas y pasa directo a [TRIAJE_P1] y [TRIAJE_P2] juntos.

CUANDO TENGAS LA RESPUESTA MAPEADA, incluye al final:
[TRIAJE_P1: <opción exacta>]

ESCALADO — SOLO con [ESCALAR] si pide explícitamente hablar con humano.
NUNCA digas que eres IA. Solo español.`;

    } else if (estado === 'triaje_p2') {
      systemPrompt = `Eres Carolina, asesora de NHC Kids. WhatsApp — cálida, cercana.

REGLAS: Máximo 3 líneas, separa con --- si necesitas más, sin negritas.

TRIAJE EN CURSO para ${nombre}:
- P1 (dificultad): ${triaje.triaje1 || 'pendiente'}

TU TAREA:
Interpreta la respuesta del padre sobre el tiempo y mapéala a:
${TRIAJE_P2.join(', ')}
Luego haz la TERCERA PREGUNTA:
"¿Qué han intentado hasta ahora para ayudar a su hijo/a?"
Opciones: Psicología, Neuropsicología, Apoyo escolar, Medicación, Varias sin resultado, Nada aún, Otro

Al final incluye:
[TRIAJE_P2: <opción exacta>]

NUNCA digas que eres IA. Solo español.`;

    } else if (estado === 'triaje_p3') {
      systemPrompt = `Eres Carolina, asesora de NHC Kids. WhatsApp — cálida, cercana.

REGLAS: Máximo 3 líneas, separa con --- si necesitas más, sin negritas.

TRIAJE EN CURSO para ${nombre}:
- P1 (dificultad): ${triaje.triaje1}
- P2 (tiempo): ${triaje.triaje2}

TU TAREA:
Interpreta la respuesta del padre sobre lo que han intentado y mapéala a:
${TRIAJE_P3.join(', ')}

Luego muestra empatía con lo que han vivido y presenta el Neuromapeo como solución:
"Con el Neuromapeo cerebral vamos a entender exactamente qué está pasando en el cerebro de tu hijo/a para diseñar un plan personalizado."
Precio: $395.000. Reserva: $100.000 (resto al llegar).
Pregunta si quiere agendar.

Al final incluye:
[TRIAJE_P3: <opción exacta>]
[TRIAJE_COMPLETO]

NUNCA digas que eres IA. Solo español.`;

    } else if (estado === 'triaje_completo' || estado === 'agendando') {
      systemPrompt = `Eres Carolina, asesora de NHC Kids. WhatsApp — cálida, cercana.

REGLAS: Máximo 3 líneas, separa con --- si necesitas más, sin negritas.

CONTEXTO de ${nombre}:
- Dificultad del hijo/a: ${triaje.triaje1}
- Tiempo observando: ${triaje.triaje2}
- Han intentado: ${triaje.triaje3}

PROCESO: Pre-diagnóstico (30min con Juan Esteban) + Neuromapeo cerebral (1 hora).
Precio: $395.000. Reserva: $100.000 (resto al llegar).

DISPONIBILIDAD REAL (usa SOLO estos horarios):
${disponibilidadTexto}
NUNCA confirmes horarios que no estén en esta lista.

DATOS QUE NECESITAS (recoge natural, uno a uno):
1. Nombre completo del niño/a
2. Edad
3. Género (niño/niña)
4. ¿Estudia actualmente?
5. Nombre completo del papá/mamá
6. Correo electrónico del papá/mamá
7. Ciudad de residencia

CUANDO TENGAS LOS 7 DATOS Y EL PADRE CONFIRME HORARIO:
Pide confirmación ("¿Confirmamos para ese día y hora?").
Cuando confirme, responde EXACTAMENTE:
[CITA_CONFIRMADA]
fecha: <YYYY-MM-DD>
hora: <HH:MM en 24h>
nombre_nino: <nombre completo del niño/a>
edad: <edad>
genero: <Masculino/Femenino/Otro>
estudia: <si/no>
nombre_padre: <nombre completo del papá/mamá>
email: <correo electrónico>
ciudad: <ciudad>

Si pregunta por convenio, póliza o prepagada → responde: "Sí manejamos convenios con COMFAMA y FEISA. Un asesor te contactará pronto para validar los datos necesarios." → luego [ESCALAR]
VALIDACIÓN DE CIUDAD — cuando el padre diga su ciudad:
Ciudades ACEPTADAS: Medellín, Bello, La Estrella, Copacabana, Envigado, Itagüí, Sabaneta, Barbosa, Caldas, Rionegro, La Ceja, Guarne, El Retiro, Marinilla, El Carmen de Viboral, San Vicente, Santuario, y municipios cercanos de Antioquia.
Si la ciudad NO está en esa lista → incluye [CIUDAD_NO_DISPONIBLE] en tu respuesta y no continúes con la cita.

ESCALADO — SOLO con [ESCALAR] si pide hablar con humano o queja grave.
NUNCA digas que eres IA. Solo español.`;

    } else if (estado === 'esperando_pago') {
      systemPrompt = `Eres Carolina, asesora de NHC Kids. WhatsApp — cálida, cercana.

REGLAS: Máximo 3 líneas, sin negritas.

CONTEXTO: ${nombre} acaba de confirmar su cita y debe hacer la reserva de $100.000.
Se le preguntó qué medio de pago prefiere. Según su respuesta:

Si elige opción 1 (Link / Wompi / virtual / online) → responde EXACTAMENTE: [MEDIO_WOMPI]
Si elige opción 2 (Transferencia / consignación / Bancolombia) → responde EXACTAMENTE: [MEDIO_TRANSFERENCIA]
Si elige opción 3 (QR) → responde EXACTAMENTE: [MEDIO_QR]

Si ya recibió el medio de pago y pregunta sobre el estado → responde con confianza.
Si pregunta por convenio, póliza o prepagada → responde: "Sí manejamos convenios con COMFAMA y FEISA. Un asesor te contactará pronto para validar los datos necesarios." → luego [ESCALAR]
Si pide cambiar la cita → [ESCALAR]
Si pide hablar con humano → [ESCALAR]

NUNCA digas que eres IA. Solo español.`;
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01', 'Content-Type':'application/json' },
      body: JSON.stringify({ model:'claude-sonnet-4-5', max_tokens:500, system:systemPrompt, messages:history })
    });

    const claudeData = await claudeRes.json();
    console.log('CLAUDE:', JSON.stringify(claudeData));
    const rawReply = claudeData.content[0].text;

    // ─── PROCESAR RESPUESTA DE CLAUDE ─────────────────────────────────────────
    let nuevoEstado = estado;
    let nuevoTriaje = { ...triaje };

    // Captura nombre del padre en estado nuevo
    const matchNombrePadre = rawReply.match(/\[NOMBRE_PADRE:\s*(.+?)\]/);
    if (matchNombrePadre && estado === 'nuevo') {
      const nombreCapturado = matchNombrePadre[1].trim();
      nuevoEstado = 'triaje_p1';
      // Actualizar nombre en GHL
      try {
        const partes = nombreCapturado.split(' ');
        await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
          body: JSON.stringify({ firstName: partes[0], lastName: partes.slice(1).join(' ') || '' })
        });
        await pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(()=>{});
        console.log('NOMBRE PADRE capturado:', nombreCapturado);
      } catch(e) { console.error('Error actualizando nombre:', e.message); }
    }

    const matchP1 = rawReply.match(/\[TRIAJE_P1:\s*(.+?)\]/);
    const matchP2 = rawReply.match(/\[TRIAJE_P2:\s*(.+?)\]/);
    const matchP3 = rawReply.match(/\[TRIAJE_P3:\s*(.+?)\]/);
    const triajeCompleto = rawReply.includes('[TRIAJE_COMPLETO]');

    if (matchP1) {
      nuevoTriaje.triaje1 = matchP1[1].trim();
      nuevoEstado = 'triaje_p2';
      console.log('TRIAJE P1:', nuevoTriaje.triaje1);
    }
    if (matchP2) {
      nuevoTriaje.triaje2 = matchP2[1].trim();
      nuevoEstado = 'triaje_p3';
      console.log('TRIAJE P2:', nuevoTriaje.triaje2);
    }
    if (matchP3) {
      nuevoTriaje.triaje3 = matchP3[1].trim();
      console.log('TRIAJE P3:', nuevoTriaje.triaje3);
    }
    if (triajeCompleto) {
      nuevoEstado = 'triaje_completo';
      addTag(contactId, `nhck-triaje-${nuevoTriaje.triaje1?.toLowerCase().replace(/[^a-z0-9]/g,'-').substring(0,20) || 'completado'}`).catch(()=>{});
      actualizarEtapaOportunidad(contactId, STAGE_INICIO).catch(()=>{});
      console.log('TRIAJE COMPLETO:', nuevoTriaje);
    }

    // ─── CITA CONFIRMADA ──────────────────────────────────────────────────────
    if (rawReply.includes('[CITA_CONFIRMADA]')) {
      const extract = f => { const m = rawReply.match(new RegExp(`${f}:\\s*(.+)`)); return m ? m[1].trim() : ''; };
      const fechaCita = extract('fecha'), horaCita = extract('hora');
      const nombreNino = extract('nombre_nino'), edad = extract('edad');
      const genero = extract('genero');
      const estudiaSt = extract('estudia').toLowerCase();
      const estudia = estudiaSt === 'si' || estudiaSt === 'sí';
      const emailCita = extract('email') || contact.email || '';
      const nombrePadreCita = extract('nombre_padre') || `${contact.firstName||''} ${contact.lastName||''}`.trim();
      const ciudadCita = extract('ciudad') || contact.city || '';

      console.log('CITA CONFIRMADA:', { fechaCita, horaCita, nombreNino, edad, genero, estudia });

      // Actualizar datos del padre en GHL
      const ghlUpdate = {};
      if (emailCita && emailCita !== contact.email) ghlUpdate.email = emailCita;
      if (ciudadCita && ciudadCita !== contact.city) ghlUpdate.city = ciudadCita;
      if (nombrePadreCita) {
        const partes = nombrePadreCita.trim().split(' ');
        ghlUpdate.firstName = partes[0] || contact.firstName || '';
        ghlUpdate.lastName = partes.slice(1).join(' ') || contact.lastName || '';
      }
      if (Object.keys(ghlUpdate).length > 0) {
        fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${GHL_KEY}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
          body: JSON.stringify(ghlUpdate)
        }).catch(()=>{});
        await pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(()=>{});
        console.log('Datos padre actualizados en GHL:', ghlUpdate);
      }

      await guardarCamposNinoGHL(contactId, { nombreNino, edadNino: edad, generoNino: genero, estudia, sintoma: nuevoTriaje.triaje1 });
      actualizarEtapaOportunidad(contactId, STAGE_INFO_COMPLETA).catch(()=>{});

      const referencia = `NHCK-${contactId}-${Date.now()}`;
      await logEvent(contactId, conversationId, 'cita_confirmada', { fechaCita, horaCita, referencia });

      let linkPago = null;
      try {
        const pagoResult = await generarLinkPago({ referencia, monto:100000,
          nombre: `${contact.firstName||''} ${contact.lastName||''}`.trim(),
          email: emailCita || contact.email||'', telefono: contact.phone||'' });
        linkPago = pagoResult.url;
        const contactConDatos = { ...contact, email: emailCita || contact.email || '', city: ciudadCita || contact.city || '', firstName: nombrePadreCita.split(' ')[0] || contact.firstName || '', lastName: nombrePadreCita.split(' ').slice(1).join(' ') || contact.lastName || '' };
        await savePendingPayment(referencia, { contactId, conversationId, contact: contactConDatos, fechaCita, horaCita,
          edad, genero, ocupacion: mapearOcupacionNino(estudia), sintoma: nuevoTriaje.triaje1,
          nombreNino, nombre: nombrePadreCita || nombre, paymentLinkId: pagoResult.linkId });
      } catch (err) {
        console.error('Error link pago:', err.message);
        const contactConDatos = { ...contact, email: emailCita || contact.email || '', city: ciudadCita || contact.city || '' };
        await savePendingPayment(referencia, { contactId, conversationId, contact: contactConDatos, fechaCita, horaCita,
          edad, genero, ocupacion: mapearOcupacionNino(estudia), sintoma: nuevoTriaje.triaje1,
          nombreNino, nombre: nombrePadreCita || nombre, paymentLinkId: null });
      }

      history.push({ role:'assistant', content:[{ type:'text', text:'Cita confirmada, preguntando medio de pago.' }] });
      await saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', lastMsgId, phone);
      await humanDelay();

      // Preguntar medio de pago
      await sendMessage(conversationId,
        `Para confirmar tu cupo necesitamos la reserva de $100.000 💳\n¿Cuál medio de pago te queda más fácil?\n\n1️⃣ Link de pago virtual (Wompi)\n2️⃣ Transferencia / consignación Bancolombia\n3️⃣ QR de pago`,
        contactId);

      actualizarEtapaOportunidad(contactId, STAGE_LINK_PAGO).catch(()=>{});
      iniciarTimersInactividad(conversationId, contactId);
      // ya respondido: return res.json({ success:true, citaPendientePago:true, referencia }); return;
    }

    // ─── ESCALAR ──────────────────────────────────────────────────────────────
    // ─── MEDIOS DE PAGO ───────────────────────────────────────────────────────
    if (estado === 'esperando_pago') {
      // Buscar pending payment para tener la referencia
      const pendingRes = await pool.query(
        'SELECT * FROM pending_payments WHERE contact_id=$1 ORDER BY created_at DESC LIMIT 1',
        [contactId]
      );
      const pending = pendingRes.rows[0];

      if (rawReply.includes('[MEDIO_WOMPI]') && pending) {
        const pagoResult = await generarLinkPago({ referencia: pending.referencia, monto: 100000,
          nombre: `${contact.firstName||''} ${contact.lastName||''}`.trim(),
          email: pending.contact_data?.email || contact.email || '',
          telefono: contact.phone || '' }).catch(() => null);
        const linkPago = pagoResult?.url;
        await humanDelay();
        if (linkPago) {
          await sendMessages(conversationId, [
            `Aquí tienes tu link de pago seguro 👇
${linkPago}`,
            `Una vez completado te envío los detalles de tu cita 🙌`
          ], contactId);
        }
        await saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', lastMsgId, phone);
        // ya respondido: return res.json({ success: true, medio: 'wompi' }); return;
      }

      if (rawReply.includes('[MEDIO_TRANSFERENCIA]')) {
        await humanDelay();
        await sendMessages(conversationId, [
          `Puedes hacer la transferencia o consignación por $100.000 a esta cuenta 👇`,
          `Bancolombia — Cuenta de Ahorros
Número: 90790901451
Llave: 0090435866
A nombre de: Visión Integral Transformación Personal y Organizacional SAS
NIT: 901164425`,
          `Una vez realizado el pago envíame aquí la foto o captura del comprobante y confirmo tu cita 📸`
        ], contactId);
        await saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', lastMsgId, phone);
        // ya respondido: return res.json({ success: true, medio: 'transferencia' }); return;
      }

      if (rawReply.includes('[MEDIO_QR]')) {
        await humanDelay();
        await sendMessage(conversationId, `Escanea este QR para pagar $100.000 👇`, contactId);
        await new Promise(r => setTimeout(r, 1000));
        await sendImage(conversationId, contactId,
          'https://miraculous-solace-production-47dd.up.railway.app/public/pagosQR.jpeg',
          'QR de pago NHC Kids');
        await new Promise(r => setTimeout(r, 1000));
        await sendMessage(conversationId, `También puedes usar la llave Bancolombia: 0090435866
Cuando pagues envíame el comprobante y confirmo tu cita 🙌`, contactId);
        await saveConversationData(conversationId, contactId, history, nuevoTriaje, 'esperando_pago', lastMsgId, phone);
        // ya respondido: return res.json({ success: true, medio: 'qr' }); return;
      }
    }

    // ─── CIUDAD NO DISPONIBLE ─────────────────────────────────────────────────
    if (rawReply.includes('[CIUDAD_NO_DISPONIBLE]')) {
      const replyLimpio = rawReply.replace(/\[CIUDAD_NO_DISPONIBLE\]/g, '').trim();
      const partes = replyLimpio.split('---').map(p => p.trim()).filter(p => p.length > 0);
      history.push({ role:'assistant', content:[{ type:'text', text: replyLimpio }] });
      await saveConversationData(conversationId, contactId, history, nuevoTriaje, 'escalado', lastMsgId, phone);
      await addTag(contactId, 'escalado nhck');
      await logEvent(contactId, conversationId, 'ciudad_no_disponible', { ciudad: lastMsg });
      await humanDelay();
      await sendMessages(conversationId, partes, contactId);
      // ya respondido: return res.json({ success:true, ciudad_no_disponible:true }); return;
    }

    if (rawReply.includes('[ESCALAR]')) {
      await addTag(contactId, 'escalado nhck');
      await logEvent(contactId, conversationId, 'escalado', { motivo: lastMsg });
      await saveConversationData(conversationId, contactId, history, nuevoTriaje, 'escalado', lastMsgId, phone);
      await humanDelay();
      await sendMessage(conversationId, 'En un momento un asesor te va a ayudar 🙌', contactId);
      // ya respondido: return res.json({ success:true, escalated:true }); return;
    }

    // ─── RESPUESTA NORMAL ──────────────────────────────────────────────────────
    const reply = rawReply
      .replace(/\[TRIAJE_P[123]:[^\]]+\]/g, '')
      .replace(/\[TRIAJE_COMPLETO\]/g, '')
      .replace(/\[NOMBRE_PADRE:[^\]]+\]/g, '')
      .replace(/\[MEDIO_WOMPI\]/g, '')
      .replace(/\[MEDIO_TRANSFERENCIA\]/g, '')
      .replace(/\[MEDIO_QR\]/g, '')
      .replace(/\[CIUDAD_NO_DISPONIBLE\]/g, '')
      .split('\n').filter(l => l.trim() !== '').join('\n');

    const partes = reply.split('---').map(p => p.trim()).filter(p => p.length > 0);

    history.push({ role:'assistant', content:[{ type:'text', text:reply }] });
    await saveConversationData(conversationId, contactId, history, nuevoTriaje, nuevoEstado, lastMsgId, phone);
    await humanDelay();
    await sendMessages(conversationId, partes, contactId);
    iniciarTimersInactividad(conversationId, contactId);
    console.log('RESPUESTA OK:', { reply: reply?.substring(0,50), estado: nuevoEstado });

  } catch (error) {
    console.error('Error webhook GHL:', error);
    console.error("Error interno:", error.message);
  }
});

// ─── WEBHOOK WOMPI ────────────────────────────────────────────────────────────
app.post('/webhook/wompi', async (req, res) => {
  try {
    console.log('WOMPI WEBHOOK:', JSON.stringify(req.body));
    const transaccion = req.body?.data?.transaction;
    if (!transaccion) return res.json({ received:true });
    const { reference, status } = transaccion;
    console.log('WOMPI TX:', { reference, status });

    const checksum = req.body?.signature?.checksum;
    const properties = req.body?.signature?.properties || [];
    const timestamp = req.body?.timestamp;
    if (checksum && properties.length > 0 && timestamp) {
      const cadena = properties.map(p => {
        const keys = p.split('.');
        let val = req.body.data;
        for (const k of keys) val = val?.[k];
        return val !== undefined && val !== null ? String(val) : '';
      }).join('') + String(timestamp) + WOMPI_INTEGRITY_KEY;
      const firmaCalc = crypto.createHash('sha256').update(cadena).digest('hex');
      if (firmaCalc !== checksum) {
        console.error('Firma Wompi inválida — procesando de todas formas en modo test');
        if (req.body?.environment !== 'test') return res.status(401).json({ error:'Firma inválida' });
      }
    }

    if (status !== 'APPROVED') {
      await logEvent(null, null, 'pago_rechazado', { reference, status });
      return res.json({ received:true });
    }

    const datos = await getPendingPayment(reference);
    if (!datos) { console.log('Referencia no encontrada:', reference); return res.json({ received:true }); }

    const { contactId, conversationId, contact, fechaCita, horaCita, edad, genero, ocupacion, sintoma, nombreNino, nombre } = datos;
    await logEvent(contactId, conversationId, 'pago_aprobado', { reference, fechaCita, horaCita });

    let resultado = null;
    try {
      resultado = await crearEnAnamnesis({ nombreNino: nombreNino||contact.firstName||'',
        email: contact.email||'', movil: contact.phone||'', contactIdGHL: contactId,
        edad, sintoma, genero, estudia: ocupacion === 'Estudiante de colegio' });
      console.log('ANAMNESIS OK:', JSON.stringify(resultado));
    } catch (err) { console.error('Error Anamnesis:', err.message); }

    try {
      const citas = await crearCitasCalendario({ movil: contact.phone||'', email: contact.email||'',
        fechaISO: fechaCita, horaInicio: horaCita, contactoID: resultado?.contactoID||null, nombreNino: nombreNino||'' });
      console.log('CITAS OK:', JSON.stringify(citas));
      await logEvent(contactId, conversationId, 'citas_creadas', citas);
      await pool.query('DELETE FROM availability_cache WHERE fecha_iso=$1', [fechaCita]).catch(()=>{});
    } catch (err) { console.error('Error Citas:', err.message); }

    const mesesN = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const [,mm,dd] = (fechaCita||'').split('-');
    const fechaL = fechaCita ? `${parseInt(dd)} de ${mesesN[parseInt(mm)-1]}` : 'la fecha acordada';
    const [hh,min] = (horaCita||'00:00').split(':');
    const hN = parseInt(hh);
    const horaL = `${hN>12?hN-12:hN===0?12:hN}:${min}${hN<12?'am':'pm'}`;

    await addTag(contactId, 'escalado nhck');
    await addTag(contactId, 'pagó 100K nhck');
    await deletePendingPayment(reference);
    actualizarEtapaOportunidad(contactId, STAGE_PAGO_PARCIAL).catch(()=>{});
    limpiarTimers(conversationId);

    await sendMessages(conversationId, [
      `✅ ¡Pago recibido ${nombre}! Tu cita está confirmada para el ${fechaL} a las ${horaL} 🎉`,
      `Recuerda llegar 10 minutos antes. ¡Nos vemos pronto! 🙌`,
      `En breve uno de nuestros asesores te escribirá para coordinar los últimos detalles: ubicación del centro, test previo y recomendaciones para el proceso. 🙏`
    ], contactId);

    return res.json({ received:true });
  } catch (error) {
    console.error('Error webhook Wompi:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/pago-exitoso', (req, res) => {
  res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:3rem">¡Pago recibido! Tu cita está confirmada. Puedes cerrar esta ventana.</h2>');
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
}).catch(err => { console.error('Error DB:', err); process.exit(1); });