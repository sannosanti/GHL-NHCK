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

function iniciarTimersInactividad(conversationId, contactId, sendMessage) {
  limpiarTimers(conversationId);
  inactivityTimers[conversationId] = {
    timer5: setTimeout(async () => {
      try { await sendMessage(conversationId, '¿Sigues por ahí? 😊 Quedo pendiente por si tienes alguna duda.', contactId); }
      catch (err) { console.error('Error timer 5min:', err.message); }
    }, 5 * 60 * 1000),
    timer10: setTimeout(async () => {
      try { await sendMessage(conversationId, 'Por ahora cerramos la conversación pero quedamos atentos 🙌\nCuando quieras retomar el proceso nos escribes y con gusto te ayudamos.', contactId); }
      catch (err) { console.error('Error timer 10min:', err.message); }
    }, 10 * 60 * 1000),
  };
}

module.exports = { limpiarTimers, iniciarTimersInactividad };
