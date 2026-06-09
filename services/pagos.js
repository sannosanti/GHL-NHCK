'use strict';

const fetch = require('node-fetch');
const crypto = require('crypto');
const { env, constants } = require('../config');

async function generarLinkPago({ referencia, monto, nombre, email, telefono }) {
  const montoEnCentavos = monto * 100;
  const cadena = `${referencia}${montoEnCentavos}COP${env.wompiIntegrityKey}`;
  const firma = crypto.createHash('sha256').update(cadena).digest('hex');
  const res = await fetch(`${constants.WOMPI_BASE_URL}/payment_links`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.wompiPrivateKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Reserva NHC Kids - Neuromapeo',
      description: 'Reserva para el proceso de Neuromapeo Kids ($100.000)',
      single_use: true,
      collect_shipping: false,
      currency: 'COP',
      amount_in_cents: montoEnCentavos,
      reference: referencia,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      redirect_url: 'https://miraculous-solace-production-47dd.up.railway.app/pago-exitoso',
      signature: { integrity: firma },
      customer_data: {
        customer_name: nombre || '',
        customer_last_name: '',
        customer_legal_id: '',
        customer_legal_id_type: 'CC',
        customer_email: email || '',
        customer_phone: (telefono || '').replace(/[\s+\(\)\-]/g, ''),
      },
    }),
  });
  const data = await res.json();
  console.log('WOMPI PAYMENT LINK:', JSON.stringify(data));
  if (data?.data?.id) return { url: `https://checkout.wompi.co/l/${data.data.id}`, linkId: data.data.id };
  const params = new URLSearchParams({
    'public-key': env.wompiPublicKey,
    currency: 'COP',
    'amount-in-cents': montoEnCentavos,
    reference: referencia,
    'signature:integrity': firma,
    'customer-data:email': email || '',
    'customer-data:full-name': nombre || '',
    'customer-data:phone-number': (telefono || '').replace(/[\s+\(\)\-]/g, ''),
    'redirect-url': 'https://miraculous-solace-production-47dd.up.railway.app/pago-exitoso',
  });
  return { url: `https://checkout.wompi.co/p/?${params.toString()}`, linkId: null };
}

module.exports = { generarLinkPago };
