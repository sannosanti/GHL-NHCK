'use strict';

// Lee el comprobante de pago que manda el paciente.
//
// Hasta ahora el bot solo detectaba que habia un adjunto: cualquier foto en
// estado esperando_pago se trataba como pago, se creaba la cita en Zoho y se
// respondia "recibimos tu comprobante". Una foto del carne, una captura de la
// conversacion o una foto cualquiera producian lo mismo.
//
// Esto NO valida el pago. Leer un monto de una foto no es verificar que la
// transferencia existio: eso lo sigue haciendo contabilidad. Lo que resuelve es
// (a) distinguir un comprobante de una foto que no lo es, y (b) darle al asesor
// el monto y el banco en la nota interna en vez de "llego una imagen".

const fetch = require('node-fetch');
const { env } = require('../config');

const MODEL_ID = process.env.CLAUDE_MODEL_ID || 'claude-sonnet-5';

// La API rechaza imagenes grandes. El limite real es por tamano de la peticion;
// 4 MB de binario deja margen holgado una vez codificado en base64.
const MAX_BYTES = 4 * 1024 * 1024;

const TIPOS = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp',
};

function tipoDesdeUrl(url) {
  const ext = String(url).split('?')[0].split('.').pop().toLowerCase();
  return TIPOS[ext] || null;
}

const PROMPT = `Mira la imagen y responde SOLO con un objeto JSON, sin texto alrededor.

{
  "esComprobante": true o false,
  "monto": "el valor pagado tal como aparece, o null",
  "banco": "entidad o app desde la que se pago, o null",
  "fecha": "fecha de la transaccion tal como aparece, o null",
  "referencia": "numero de aprobacion o referencia, o null",
  "descripcion": "una frase corta describiendo que se ve"
}

esComprobante es true solo si la imagen muestra una transferencia, consignacion,
pago o recibo con un monto. Una foto de un documento de identidad, una captura de
una conversacion, una foto personal o cualquier otra cosa es false.

No inventes datos: si un campo no se ve con claridad, ponlo en null.`;

/**
 * @param {string} imageUrl adjunto que llego por el webhook de GHL
 * @returns {Promise<object|null>} datos leidos, o null si no se pudo leer
 */
async function leerComprobante(imageUrl) {
  try {
    if (!imageUrl) return null;
    const mediaType = tipoDesdeUrl(imageUrl);
    if (!mediaType) {
      console.warn('[comprobante] extension no soportada:', imageUrl);
      return null;
    }

    const img = await fetch(imageUrl);
    if (!img.ok) {
      console.warn(`[comprobante] no se pudo descargar: HTTP ${img.status}`);
      return null;
    }
    const buf = await img.buffer();
    if (buf.length > MAX_BYTES) {
      console.warn(`[comprobante] imagen de ${buf.length} bytes, supera el limite`);
      return null;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });
    const data = await res.json();
    if (data.type === 'error' || !Array.isArray(data.content)) {
      console.error('[comprobante] error de la API:', JSON.stringify(data).slice(0, 300));
      return null;
    }

    // Sonnet 5 puede anteponer un bloque de razonamiento: hay que buscar el
    // bloque de texto en vez de leer content[0], que ya rompio el bot antes.
    const texto = (data.content.find(b => b.type === 'text') || {}).text || '';
    const json = texto.match(/\{[\s\S]*\}/);
    if (!json) {
      console.warn('[comprobante] la respuesta no traia JSON:', texto.slice(0, 200));
      return null;
    }
    const leido = JSON.parse(json[0]);
    console.log('[comprobante]', JSON.stringify(leido));
    return leido;
  } catch (err) {
    // Nunca romper el flujo del pago por esto: si no se puede leer, quien llama
    // sigue como antes.
    console.error('[comprobante] fallo la lectura:', err.message);
    return null;
  }
}

/** Resumen de una linea para la nota interna del asesor. */
function resumirParaAsesor(leido) {
  if (!leido) return null;
  if (leido.esComprobante === false) {
    return `⚠️ La imagen NO parece un comprobante: ${leido.descripcion || 'sin descripcion'}`;
  }
  const partes = [
    leido.monto ? `monto ${leido.monto}` : null,
    leido.banco ? `banco ${leido.banco}` : null,
    leido.fecha ? `fecha ${leido.fecha}` : null,
    leido.referencia ? `ref ${leido.referencia}` : null,
  ].filter(Boolean);
  return `Comprobante recibido — ${partes.length ? partes.join(' · ') : 'sin datos legibles'}. Falta validacion de contabilidad.`;
}

module.exports = { leerComprobante, resumirParaAsesor };
