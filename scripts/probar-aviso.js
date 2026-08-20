// Dispara un aviso de prueba al canal configurado. Sirve para verificar que
// CLIQ_WEBHOOK_URL está bien puesta sin escribir nada en la base ni esperar a
// que ocurra un error real.
//
//   railway run node scripts/probar-aviso.js
const { env } = require('../config');
const { notify } = require('../services/notifier');

(async () => {
  console.log('agente          :', env.agentName || '(sin AGENT_NAME)');
  console.log('canal técnico   :', env.cliqWebhookUrl ? 'configurado' : 'FALTA');
  console.log('canal anamnesis :', env.cliqWebhookAnamnesis ? 'configurado' : 'sin configurar (cae en el técnico)');
  console.log();

  const ok = await notify(
    `Prueba de avisos\nSi ves este mensaje, el canal quedó bien configurado.\n${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
  );
  console.log(ok ? '\nOK: Cliq aceptó el aviso.' : '\nFALLO: revisá el detalle de arriba.');
  process.exit(ok ? 0 : 1);
})();
