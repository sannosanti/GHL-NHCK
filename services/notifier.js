'use strict';

const fetch = require('node-fetch');
const { env } = require('../config');

/**
 * Avisos por Zoho Cliq.
 *
 * Antes esto salía por Zoho Mail usando el MISMO refresh token que Zoho
 * Creator, y ahí había dos fallas encima:
 *
 * 1. Ese token nunca tuvo permisos de correo, así que Zoho respondía
 *    INVALID_OAUTHSCOPE y NINGÚN aviso salía. Silencioso, porque el error se
 *    tragaba en el catch.
 * 2. Aunque hubiera funcionado, el canal compartía la falla con lo que vigila.
 *    El 2026-08-20 Creator agotó su cuota diaria; cada cita que caía mal
 *    disparaba su alerta, y todas las alertas viajaban por Zoho. El sistema sí
 *    avisó — el aviso era lo que estaba roto. Nadie se enteró en cuatro horas.
 *
 * Un webhook entrante de Cliq no usa el token OAuth: lleva su propia clave en
 * la URL. Así que no le afecta ni el permiso que faltaba ni la cuota de
 * Creator, que son justo las dos cosas que rompieron ese día.
 *
 * Sirven las dos formas de URL que da Cliq, porque acá se usa un bot
 * ("SIA NOTIFICATIONS") y no un canal suelto:
 *
 *   bot     https://cliq.zoho.com/api/v2/bots/{nombre}/incoming?zapikey=...
 *   canal   https://cliq.zoho.com/api/v2/channelsbyname/{canal}/message?zapikey=...
 *
 * Configuración (variables de entorno):
 *   CLIQ_WEBHOOK_URL        destino del equipo técnico — errores y alertas
 *   CLIQ_WEBHOOK_ANAMNESIS  destino de quien atiende pacientes (opcional)
 */

const LIMITE_CLIQ = 12000;   // Cliq rechaza mensajes muy largos.

/**
 * @param {string} text     Texto del aviso.
 * @param {string} [destino] URL de webhook alterna. Por defecto, el canal técnico.
 */
async function notify(text, destino) {
  const url = destino || env.cliqWebhookUrl;
  if (!url) {
    // Sin canal configurado el aviso se pierde, y perder avisos en silencio es
    // exactamente lo que costó cuatro horas de operación. Que se vea.
    console.error('[notifier] SIN CANAL: falta CLIQ_WEBHOOK_URL. Aviso NO enviado:', String(text).split('\n')[0]);
    return false;
  }

  const cuerpo = String(text || '').slice(0, LIMITE_CLIQ);
  // Un bot entrega el mensaje a sus suscriptores y necesita `broadcast` para
  // llegarles a todos; un canal no lo lleva. Se decide por la URL en vez de
  // pedir otra variable de entorno que alguien tendría que acertar.
  const carga = url.includes('/bots/')
    ? { text: cuerpo, broadcast: true }
    : { text: cuerpo };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(carga),
    });
    const respuesta = await res.text();
    if (!res.ok) {
      console.error(`[notifier] Cliq rechazó el aviso: HTTP ${res.status} ${respuesta.slice(0, 200)}`);
      return false;
    }
    console.log('[notifier] Aviso enviado a Cliq:', cuerpo.split('\n')[0].slice(0, 80));
    return true;
  } catch (err) {
    console.error('[notifier] No se pudo enviar el aviso a Cliq:', err.message);
    return false;
  }
}

// Un error del sistema SIEMPRE es del equipo técnico, así que a propósito no
// recibe canal alterno: no tiene sentido mandarle una traza a quien atiende
// pacientes. Para otros destinos, usar notify() directamente.
async function notifyError(context, err) {
  const msg = err?.message || String(err);
  return notify(`🚨 Error — ${context}\n${msg}\n${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
}

module.exports = { notify, notifyError };
