'use strict';

const fetch = require('node-fetch');
const { env, constants, mapearSintoma, mapearGenero, mapearOcupacionNino } = require('../config');
const db = require('../db');

// ─── ZOHO TOKEN (module-scoped, private) ─────────────────────────────────────
let zohoAccessToken = null;
let zohoTokenExpiry = 0;

async function getZohoAccessToken() {
  if (zohoAccessToken && Date.now() < zohoTokenExpiry) return zohoAccessToken;
  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.zohoClientId,
      client_secret: env.zohoClientSecret,
      refresh_token: env.zohoRefreshToken,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('No token Zoho: ' + JSON.stringify(data));
  zohoAccessToken = data.access_token;
  zohoTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log('Token Zoho renovado');
  return zohoAccessToken;
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
        Genero: mapearGenero(genero), Ocupaci_n: ocupacion,
      }}),
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
      Ocupaci_n: ocupacion, Tipo_Proceso: 'Diagnóstico', Estado_Paciente: 'Activo',
    }}),
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
  const meses = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(fechaISO + 'T00:00:00');
  const dd = String(d.getDate()).padStart(2, '0');
  const mmm = meses[d.getMonth()];
  const yyyy = d.getFullYear();
  const pad = n => String(n).padStart(2, '0');
  const fmt = (h, m) => `${dd}-${mmm}-${yyyy} ${pad(h)}:${pad(m)}:00`;
  const diaStr = `${dd}-${mmm}-${yyyy}`;
  const fin1H = mIni + 30 >= 60 ? hIni + 1 : hIni; const fin1M = (mIni + 30) % 60;
  const ini2H = fin1H; const ini2M = fin1M;
  const fin2H = ini2M + 60 >= 60 ? ini2H + 1 : ini2H; const fin2M = (ini2M + 60) % 60;
  const base = {
    Tipo: 'Presencial', Contacto: contactoID || '', Email: email || '',
    Estado: 'Programada', Observaciones: 'NHC Kids - Agendado por Carolina IA', Dia: diaStr, Nombre: nombreNino || '',
  };
  const res1 = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/calendario/form/Citas', {
    method: 'POST', headers, body: JSON.stringify({ data: { ...base,
      Inicio: fmt(hIni, mIni), Fin: fmt(fin1H, fin1M), Duraci_n: '30 minutos',
      Consultor: constants.ID_CONSULTOR_JUAN_ESTEBAN, Espacio: '3572150000004826074',
    }}),
  });
  const data1 = await res1.json(); console.log('CITA 1 PRE:', JSON.stringify(data1));
  const res2 = await fetch('https://creator.zoho.com/api/v2/visionintegralceo/calendario/form/Citas', {
    method: 'POST', headers, body: JSON.stringify({ data: { ...base,
      Inicio: fmt(ini2H, ini2M), Fin: fmt(fin2H, fin2M), Duraci_n: '1 hora',
      Consultor: constants.ID_CONSULTOR_MAPEOS, Espacio: constants.ID_ESPACIO_MAPEOS,
    }}),
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
  const horarios = constants.HORARIOS_NHCK[dia];
  if (!horarios) return [];
  const ocupadosJE = [], ocupadosMapeos = [];
  citas.forEach(c => {
    const cID = c.Consultor?.ID || '';
    const tIni = new Date((c.Inicio || '').replace(/-/g, ' '));
    const tFin = new Date((c.Fin || '').replace(/-/g, ' '));
    if (isNaN(tIni)) return;
    const hIni = tIni.getHours() + tIni.getMinutes() / 60;
    const hFin = isNaN(tFin) ? hIni + 0.5 : tFin.getHours() + tFin.getMinutes() / 60;
    if (cID === constants.ID_CONSULTOR_JUAN_ESTEBAN) ocupadosJE.push({ ini: hIni, fin: hFin });
    if (cID === constants.ID_CONSULTOR_MAPEOS) ocupadosMapeos.push({ ini: hIni, fin: hFin });
  });
  const slots = [];
  for (const { ini, fin } of horarios) {
    for (let h = ini; h + 1.5 <= fin; h += 0.5) {
      const jeLibre = !ocupadosJE.some(o => o.ini < h + 0.5 && o.fin > h);
      const mapeosLibre = !ocupadosMapeos.some(o => o.ini < h + 1.5 && o.fin > h + 0.5);
      if (jeLibre && mapeosLibre) {
        const hh = Math.floor(h); const mm = (h % 1) * 60;
        const hh12 = hh > 12 ? hh - 12 : hh === 0 ? 12 : hh;
        slots.push({ label: `${hh12}:${mm === 0 ? '00' : '30'}${hh < 12 ? 'am' : 'pm'}`, horaISO: `${String(hh).padStart(2, '0')}:${mm === 0 ? '00' : '30'}` });
      }
    }
  }
  return slots;
}

module.exports = {
  getZohoAccessToken,
  buscarContactoAnamnesis,
  crearEnAnamnesis,
  crearCitasCalendario,
  getDisponibilidad,
  calcularSlotsLibres,
};
