'use strict';

// Strips every internal tag the model can emit, not just the one tag a given
// branch cares about. Each early-return branch in the GHL webhook used to
// strip only its own tag (e.g. the [ESCALAR] branch only removed
// "[ESCALAR]"), so a reply that combined tags — e.g.
// "[TRIAJE_P3: X] [TRIAJE_COMPLETO] ... [ESCALAR]", which the prompt
// explicitly asks the model to do when triage completion and escalation
// happen in the same turn — leaked the untouched tag straight to the patient
// (confirmed live on the kids side 2026-07-25).
//
// It lives here, shared, because the webhook was not the only sender: the
// recoveryJob sent the model's raw output and shipped a literal "[NHC_MENOR]"
// to a patient over WhatsApp (confirmed live 2026-07-29). Any code path that
// sends model output to a human must run it through this.
//
// Both cross-referral tags are stripped regardless of which bot this is. The
// two repos each used to strip only the other bot's tag, so a bot emitting
// its own referral tag leaked it. Neither tag should ever reach a patient.
const TAG_PATTERNS = [
  /\[TRIAJE_P[123]:[^\]]+\]/g,
  /\[TRIAJE_COMPLETO\]/g,
  /\[NOMBRE_PADRE:[^\]]+\]/g,
  /\[CIUDAD_VALIDA:[^\]]+\]/g,
  /\[MEDIO_WOMPI\]/g,
  /\[MEDIO_TRANSFERENCIA\]/g,
  /\[MEDIO_QR\]/g,
  /\[CIUDAD_NO_DISPONIBLE\]/g,
  /\[SIN_PRESUPUESTO\]/g,
  /\[FUERA_SEGMENTO\]/g,
  /\[NHC_ADULTOS\]/g,
  /\[NHC_MENOR\]/g,
  /\[CITA_CONFIRMADA\]/g,
  /\[ESCALAR\]/g,
  /\[POSPONER\]/g,
];

// Final net for any tag added to the prompt without being added above. Only
// matches ALL-CAPS bracketed tokens, which is the shape every internal tag
// uses and which no patient-facing sentence produces. Detection elsewhere
// reads the RAW reply before cleaning, so widening this never breaks routing.
const UNKNOWN_TAG = /\[[A-Z][A-Z0-9_]{2,}(?::[^\]]*)?\]/g;

function limpiarTags(text) {
  let out = text || '';
  for (const re of TAG_PATTERNS) out = out.replace(re, '');
  out = out.replace(UNKNOWN_TAG, '');
  return out.split('\n').filter(l => l.trim() !== '').join('\n');
}

module.exports = { limpiarTags };
