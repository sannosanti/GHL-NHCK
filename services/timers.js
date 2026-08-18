'use strict';

// Module-scoped state — owned exclusively by this module
const inactivityTimers = {};

function limpiarTimers(conversationId) {
  if (inactivityTimers[conversationId]) {
    clearTimeout(inactivityTimers[conversationId].timer5);
    clearTimeout(inactivityTimers[conversationId].timer10);
    delete inactivityTimers[conversationId];
  }
}

/**
 * `puedeCerrar` — comprobación opcional que corre JUSTO ANTES de despedirse.
 *
 * Existe porque el cierre por inactividad y la espera de un pago son
 * incompatibles: al pedir una consignación bancaria le dábamos diez minutos al
 * paciente y le cerrábamos el chat. Una transferencia no se hace en diez
 * minutos, así que la conversación se cerraba SIEMPRE, y el comprobante llegaba
 * a un chat ya cerrado (caso Maribel, 2026-08-18 14:00 — el bot pidió el
 * comprobante 13:52, cerró 14:00, ella lo mandó 14:02 y se descartó).
 *
 * La comprobación va antes del mensaje de despedida, no después: cerrar el
 * estado sin despedirse confunde menos que despedirse y quedar abierto.
 */
function iniciarTimersInactividad(conversationId, contactId, sendMessage, onCierre, puedeCerrar) {
  limpiarTimers(conversationId);
  inactivityTimers[conversationId] = {
    timer5: setTimeout(async () => {
      try { await sendMessage(conversationId, '¿Sigues por ahí? 😊 Quedo pendiente por si tienes alguna duda.', contactId); }
      catch (err) { console.error('Error timer 5min:', err.message); }
    }, 5 * 60 * 1000),
    timer10: setTimeout(async () => {
      try {
        await sendMessage(conversationId, 'Por ahora cerramos la conversación pero quedamos atentos 🙌\nCuando quieras retomar el proceso nos escribes y con gusto te ayudamos.', contactId);
        if (onCierre) await onCierre(conversationId, contactId);
      }
      catch (err) { console.error('Error timer 10min:', err.message); }
    }, 10 * 60 * 1000),
  };
}

module.exports = { limpiarTimers, iniciarTimersInactividad };
