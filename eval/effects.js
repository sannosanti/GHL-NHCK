'use strict';

/**
 * Effect SIMULATOR for the evaluation harness.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THIS MODULE CANNOT EXECUTE ANYTHING. It has no imports beyond the pure  │
 * │ state spec: no `services/ghl`, no `services/pagos`, no `db`, no fetch.  │
 * │ It converts effect DESCRIPTORS into frozen RECORDS and returns them.    │
 * │                                                                         │
 * │ Enforced by webhook-parity.test.js, which greps every file under eval/  │
 * │ for imports of the production side-effect modules and for the identifiers│
 * │ that move money. Adding one makes the suite fail.                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * There is no configuration, environment variable or flag that turns simulation
 * off, because there is no execution path to turn on. A payment link cannot be
 * created from eval/ by misconfiguration, only by writing new code — and that new
 * code fails the import test.
 */

const { isFinancial } = require('./state-spec');

/**
 * Convert declarative effect descriptors into simulated records.
 * Every record is frozen and carries `simulated: true`.
 */
function simulateEffects(effects = []) {
  return effects.map(e => Object.freeze({
    ...e,
    simulated: true,
    financial: isFinancial(e),
  }));
}

/** Financial records only — what the financial gate scores. */
function financialEffects(simulated = []) {
  return simulated.filter(e => e.financial);
}

/**
 * Compare the effects a model would have triggered against the ones the gold
 * label expects. Reported on its own axis: a model can emit the right tags and
 * still fire the wrong effects through combination and branch precedence.
 */
function diffEffects(got, want) {
  const key = e => JSON.stringify({ ...e, simulated: undefined, financial: undefined });
  const gotKeys = got.map(key);
  const wantKeys = want.map(key);
  const faltantes = want.filter((_, i) => !gotKeys.includes(wantKeys[i]));
  const sobrantes = got.filter((_, i) => !wantKeys.includes(gotKeys[i]));
  return {
    ok: faltantes.length === 0 && sobrantes.length === 0,
    faltantes,
    sobrantes,
    // A financial effect that should not have fired. One of these blocks migration.
    sobrantesFinancieros: sobrantes.filter(e => e.financial),
    faltantesFinancieros: faltantes.filter(e => e.financial),
  };
}

module.exports = { simulateEffects, financialEffects, diffEffects };
