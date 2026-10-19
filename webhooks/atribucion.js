'use strict';

// Sella la atribución del PRIMER toque en campos personalizados del contacto.
//
// El problema que resuelve: la atribución de Meta sí llega a SIA, pero vive
// dentro del objeto attributionSource, que no es un campo del contacto. No se
// puede filtrar en listas inteligentes ni graficar en un tablero, así que para
// el equipo comercial es como si no existiera.
//
// Hay dos detalles que obligan a que esto sea un endpoint nuestro y no una
// acción nativa del workflow:
//
//  1. POST /contacts/search devuelve attributionSource TRUNCADO — se pierden
//     formName, utmCampaign, adSetId, source y ctwaClid. Sólo el detalle,
//     GET /contacts/{id}, lo trae completo. Cualquier lectura masiva que use
//     search va a concluir que no hay atribución cuando sí la hay.
//
//  2. El contacto tiene attributionSource (primer toque) y
//     lastAttributionSource (último). La ficha de SIA muestra el último, por eso
//     parece que la atribución "cambia" cuando el paciente vuelve a escribir.
//     Medido sobre 180 contactos, sólo 3 difieren. Acá se lee siempre el
//     primero, y además sólo se escriben campos vacíos: una vez sellado el
//     origen, ninguna visita posterior lo pisa.
//
// El mapeo de abajo no es una suposición. Se verificó cruzando 77 contactos
// contra los exports de formularios de Meta: de los 68 que tenían nombre
// cargado, los 68 coincidieron exacto. Cero valores distintos. El único modo de
// falla observado es que el nombre falte, nunca que esté equivocado.
const { env } = require('../config');
const ghl = require('../services/ghl');
const db = require('../db');

// IDs reales de la location, leídos de /locations/{id}/customFields.
// Sólo se sellan los cinco campos cuyo origen está verificado. page_name,
// platform, ad_account_name y landing_de_origen quedan fuera a propósito: no
// hay dato en attributionSource que les corresponda sin inventar, y un campo
// con un valor plausible pero falso es peor para medir que uno vacío.
const CAMPO = {
  campaignName: 'Z3sbxlZn4Po0rofMSMK6',
  adsetName: 'hntdAVFGLOZMHuWv4S32',
  adName: 'UfYfC2uGPaCDWWLuXDYz',
  formName: 'RLZL7VubNPLBbPfEi7Ze',
  utmSource: '2oY8zViexx4PwnkEVpJv',
};

// GHL acomoda la jerarquía de Meta en claves que engañan: el nombre del
// conjunto viaja en utmMedium y el del anuncio en utmContent. No son los utm
// que uno esperaría por el nombre; son la jerarquía de Meta con otra etiqueta.
function desdeAtribucion(a) {
  return {
    [CAMPO.campaignName]: a.campaign || a.utmCampaign || '',
    [CAMPO.adsetName]: a.utmMedium || '',
    [CAMPO.adName]: a.utmContent || '',
    [CAMPO.formName]: a.formName || '',
    [CAMPO.utmSource]: a.utmSource || a.source || '',
  };
}

// Los leads de Click-to-WhatsApp llegan con adId y sin un solo nombre: Meta no
// los manda en ese canal. Es la mitad del volumen, así que sin esto la mitad de
// la medición queda ciega. Un adId siempre devuelve los mismos nombres, por eso
// alcanza con memoria del proceso: si el servicio reinicia se vuelven a pedir
// unas pocas veces y listo, no justifica una tabla.
const cacheAnuncios = new Map();

async function nombresDeMeta(adId) {
  if (!adId) return null;
  if (cacheAnuncios.has(adId)) return cacheAnuncios.get(adId);
  if (!env.metaToken) return null;

  const url = `https://graph.facebook.com/v23.0/${encodeURIComponent(adId)}`
    + '?fields=name,adset{name},campaign{name}'
    + `&access_token=${encodeURIComponent(env.metaToken)}`;

  let datos = null;
  try {
    const res = await fetch(url);
    const j = await res.json();
    // Un adId borrado en Meta responde error. Se cachea el null igual, para no
    // volver a preguntar por el mismo anuncio muerto en cada contacto nuevo.
    if (res.ok && j && j.name) {
      datos = {
        adName: j.name || '',
        adsetName: (j.adset && j.adset.name) || '',
        campaignName: (j.campaign && j.campaign.name) || '',
      };
    }
  } catch (err) {
    console.error(`ATRIBUCION: Meta no respondió por el anuncio ${adId}: ${err.message}`);
    return null; // Un fallo de red no se cachea: puede andar en el próximo lead.
  }

  cacheAnuncios.set(adId, datos);
  return datos;
}

function primero(...valores) {
  for (const v of valores) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

async function atribucionHandler(req, res) {
  const b = req.body || {};
  const cd = b.customData || b.custom_data || {};
  const contactId = primero(
    b.contactId, b.contact_id, cd.contactId, cd.contact_id, b.contact && b.contact.id, b.id,
  );

  // Un rechazo tiene que dejar rastro. GHL manda en el cuerpo sólo la clave
  // customData — los "datos estándar" que promete la pantalla del workflow no
  // llegan —, así que si nadie configuró el par contactId el endpoint no recibe
  // nada útil. Sin este registro, un workflow mal configurado y uno que nunca
  // disparó se ven exactamente igual: silencio. Es la trampa que costó días en
  // el workflow de recordatorios; acá se paga una fila de log por evitarla.
  if (!contactId) {
    const claves = { clavesRecibidas: Object.keys(b), clavesCustomData: Object.keys(cd) };
    console.error(`ATRIBUCION: llamada sin contactId ${JSON.stringify(claves)}`);
    await db.logEvent(null, null, 'atribucion_sin_contacto', claves).catch(() => {});
    return res.status(400).json({ ok: false, error: 'falta contactId', ...claves });
  }

  let contacto;
  try {
    const { res: r, data } = await ghl.fetchGHL(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      { headers: { Authorization: `Bearer ${env.ghlKey}`, Version: '2021-07-28', Accept: 'application/json' } },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    contacto = (data && data.contact) || null;
  } catch (err) {
    console.error(`ATRIBUCION: no se pudo leer ${contactId}: ${err.message}`);
    return res.status(502).json({ ok: false, error: `no se pudo leer el contacto: ${err.message}` });
  }

  // En "Probar flujo de trabajo" GHL manda la plantilla sin resolver, así que
  // acá cae un contactId literal "{{contact.id}}". Es la forma barata de saber
  // que el cableado quedó bien antes de que entre un paciente de verdad: este
  // evento significa que la llamada llegó con su dato, sólo que ese contacto no
  // existe. El id va en el payload y no en la columna de contacto, que espera
  // uno real.
  if (!contacto) {
    console.error(`ATRIBUCION: el contacto ${contactId} no existe en la location`);
    await db.logEvent(null, null, 'atribucion_contacto_no_hallado', { contactId }).catch(() => {});
    return res.status(404).json({ ok: false, error: 'contacto no encontrado', contactId });
  }

  const atribucion = contacto.attributionSource || {};
  const valores = desdeAtribucion(atribucion);

  // Click-to-WhatsApp: hay anuncio pero no nombres. Se completan desde Meta sin
  // tocar lo que la atribución ya traía resuelto.
  let origenNombres = 'formulario';
  if (!valores[CAMPO.adName] && atribucion.adId) {
    const m = await nombresDeMeta(atribucion.adId);
    if (m) {
      valores[CAMPO.adName] = m.adName;
      if (!valores[CAMPO.adsetName]) valores[CAMPO.adsetName] = m.adsetName;
      if (!valores[CAMPO.campaignName]) valores[CAMPO.campaignName] = m.campaignName;
      origenNombres = 'meta';
    } else {
      origenNombres = env.metaToken ? 'meta_sin_dato' : 'sin_token_meta';
    }
  }

  // El candado del primer toque. Un campo ausente del array viene vacío en GHL,
  // así que "no está" y "está en blanco" son el mismo caso.
  const actuales = new Map((contacto.customFields || []).map(f => [f.id, f.value]));
  const estaVacio = (id) => {
    const v = actuales.get(id);
    return v === undefined || v === null || String(v).trim() === '';
  };

  const aEscribir = Object.entries(valores)
    .filter(([id, valor]) => valor && estaVacio(id))
    .map(([id, value]) => ({ id, value }));

  if (!aEscribir.length) {
    const motivo = Object.values(valores).some(Boolean) ? 'ya estaban sellados' : 'el contacto no trae atribución';
    console.log(`ATRIBUCION: ${contactId} sin cambios (${motivo})`);
    return res.json({ ok: true, escritos: 0, motivo });
  }

  try {
    const { res: r } = await ghl.fetchGHL(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.ghlKey}`, Version: '2021-04-15', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: aEscribir }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    console.error(`ATRIBUCION: no se pudo escribir ${contactId}: ${err.message}`);
    await db.logEvent(contactId, null, 'atribucion_fallida', { error: err.message }).catch(() => {});
    return res.status(502).json({ ok: false, error: `no se pudo escribir: ${err.message}` });
  }

  await db.pool.query('DELETE FROM contact_cache WHERE contact_id=$1', [contactId]).catch(() => {});

  const resumen = {
    campana: valores[CAMPO.campaignName] || null,
    conjunto: valores[CAMPO.adsetName] || null,
    anuncio: valores[CAMPO.adName] || null,
    formulario: valores[CAMPO.formName] || null,
    origenNombres,
  };
  console.log(`ATRIBUCION: ${contactId} sellado (${aEscribir.length} campos, ${origenNombres})`);
  await db.logEvent(contactId, null, 'atribucion_sellada', { campos: aEscribir.length, ...resumen }).catch(() => {});

  return res.json({ ok: true, escritos: aEscribir.length, ...resumen });
}

module.exports = { atribucionHandler, desdeAtribucion, nombresDeMeta, CAMPO };
