'use strict';

/**
 * Generates eval/MATRIZ.md from state-spec.js.
 *
 *   node eval/docs.js
 *
 * Generated, never hand-written: a hand-maintained table drifts from the code the
 * moment either changes, and drift here is invisible until it corrupts a result.
 */

const fs = require('fs');
const path = require('path');
const { ACCUMULATOR, BRANCHES, TERMINAL_ESTADOS, FINANCIAL_EFFECTS, resolveStateTransition } = require('./state-spec');

const tag = (name, payload = null) => ({ name, payload });

const CASES = [
  { estado: 'nuevo', tags: [tag('NOMBRE_PADRE', 'Ana Gómez')], nota: 'solo avanza desde `nuevo`' },
  { estado: 'triaje_p1', tags: [tag('NOMBRE_PADRE', 'Ana')], nota: 'fuera de `nuevo` no avanza' },
  { estado: 'triaje_p1', tags: [tag('CIUDAD_VALIDA', 'Medellín')], nota: 'nunca mueve el estado' },
  { estado: 'triaje_p1', tags: [tag('TRIAJE_P1', 'Dificultad para concentrarse')] },
  { estado: 'triaje_p2', tags: [tag('TRIAJE_P2', 'Hace 2 años')] },
  { estado: 'triaje_p3', tags: [tag('TRIAJE_P3', 'Terapia de lenguaje')], nota: '⚠️ solo guarda: NO avanza' },
  { estado: 'triaje_p3', tags: [tag('TRIAJE_P3', 'Nada'), tag('TRIAJE_COMPLETO')], nota: 'la pareja que el prompt pide' },
  { estado: 'agendando', tags: [tag('CITA_CONFIRMADA')], nota: '⚠️ cobro real' },
  { estado: 'triaje_p1', tags: [tag('CIUDAD_NO_DISPONIBLE')] },
  { estado: 'triaje_p2', tags: [tag('SIN_PRESUPUESTO')] },
  { estado: 'triaje_p1', tags: [tag('FUERA_SEGMENTO')] },
  { estado: 'triaje_p1', tags: [tag('NHC_ADULTOS')], nota: 'retorna temprano pero la charla SIGUE' },
  { estado: 'triaje_p2', tags: [tag('ESCALAR')] },
  { estado: 'triaje_p2', tags: [tag('POSPONER')], nota: 'estado intacto; escribe recovery_status' },
  { estado: 'triaje_p1', tags: [], nota: 'sin tags no pasa nada' },

  { seccion: 'RUTAS FINANCIERAS (tres, no una)' },

  { estado: 'esperando_pago', tags: [tag('MEDIO_WOMPI')], entrada: { pendingPayment: true },
    nota: '⚠️ SEGUNDO link de pago (ghl.js:275)' },
  { estado: 'esperando_pago', tags: [tag('MEDIO_WOMPI')], entrada: { pendingPayment: false },
    nota: 'sin fila pendiente la rama no matchea y el control sigue' },
  { estado: 'esperando_pago', tags: [tag('MEDIO_WOMPI')],
    nota: 'sin el dato en contexto' },
  { estado: 'esperando_pago', tags: [tag('MEDIO_WOMPI'), tag('MEDIO_TRANSFERENCIA')], entrada: { pendingPayment: false },
    nota: 'sin pendiente gana transferencia' },
  { estado: 'triaje_p2', tags: [tag('MEDIO_WOMPI')], nota: 'fuera de esperando_pago no cobra ni consulta el dato' },
  { estado: 'esperando_pago', tags: [tag('MEDIO_TRANSFERENCIA')], nota: '⚠️ publica la cuenta Bancolombia real' },
  { estado: 'esperando_pago', tags: [tag('MEDIO_QR')], nota: '⚠️ publica la llave de pago' },
  { estado: 'esperando_pago', tags: [tag('CITA_CONFIRMADA'), tag('MEDIO_WOMPI')], entrada: { pendingPayment: true },
    nota: 'la cita gana: un link, no dos' },

  { seccion: 'CASOS COMBINATORIOS OBLIGATORIOS' },

  { estado: 'agendando', tags: [tag('CITA_CONFIRMADA'), tag('ESCALAR')], nota: '⚠️ la cita gana: **cobra igual**' },
  { estado: 'agendando', tags: [tag('CITA_CONFIRMADA'), tag('CIUDAD_NO_DISPONIBLE')], nota: '⚠️ cobra aunque cierre por ciudad' },
  { estado: 'agendando', tags: [tag('CITA_CONFIRMADA'), tag('POSPONER')], nota: '⚠️ cobra; POSPONER nunca se alcanza' },
  { estado: 'triaje_p1', tags: [tag('ESCALAR'), tag('NHC_ADULTOS')], nota: 'la derivación gana; NO escala' },
  { estado: 'triaje_p1', tags: [tag('ESCALAR'), tag('FUERA_SEGMENTO')], nota: 'el cierre gana' },
  { estado: 'triaje_p1', tags: [tag('TRIAJE_P1', 'A'), tag('TRIAJE_P2', 'B'), tag('TRIAJE_P3', 'C')], nota: 'varios de triaje en una salida' },
  { estado: 'triaje_p1', tags: [tag('TRIAJE_P1', 'TDAH'), tag('TRIAJE_P1', 'Ansiedad')], nota: 'duplicados: gana el primero (String.match)' },
  { estado: 'triaje_p1', tags: [tag('AGENDA_LISTA'), tag('TRIAJE_P1', 'TDAH')], nota: 'desconocido ignorado en ruteo; `tags:invented` lo marca aparte' },
  { estado: 'triaje_p1', tags: [tag('CIUDAD_NO_DISPONIBLE'), tag('ESCALAR')], nota: 'el cierre gana' },
  { estado: 'triaje_p1', tags: [tag('TRIAJE_P1', 'A'), tag('ESCALAR')], nota: 'acumulador corre, rama sobrescribe' },
  { estado: 'triaje_p3', tags: [tag('TRIAJE_COMPLETO'), tag('CITA_CONFIRMADA')], nota: '⚠️ rama sobre acumulador; cobra' },
];

const fmtTags = tags => (tags.length
  ? tags.map(t => `\`[${t.name}${t.payload ? `: ${t.payload}` : ''}]\``).join(' + ')
  : '_(ninguno)_');

const fmtCtx = u => {
  const parts = [];
  for (const [k, v] of Object.entries(u)) {
    if (k === 'triaje') for (const [tk, tv] of Object.entries(v)) parts.push(`\`triaje.${tk}="${tv}"\``);
    else parts.push(`\`${k}="${v}"\``);
  }
  return parts.length ? parts.join('<br>') : '—';
};

const fmtEffects = effects => (effects.length
  ? effects.map(e => (FINANCIAL_EFFECTS.has(e.type) ? `**⚠️ ${e.type}**` : e.type)).join('<br>')
  : '—');

function render() {
  const rows = [];
  for (const c of CASES) {
    if (c.seccion) {
      rows.push('| | | | | | | |');
      rows.push(`| **${c.seccion}** | | | | | | |`);
      continue;
    }
    const r = resolveStateTransition(c.estado, c.tags, c.entrada || {});

    // Una decisión indeterminada no tiene estado ni efectos que mostrar: producción
    // se comporta distinto según un dato que la evaluación no recibió.
    if (r.indeterminate) {
      rows.push('| ' + [
        `\`${c.estado}\``,
        fmtTags(c.tags),
        '**INDETERMINADO**', '—', '—', '—',
        `_${c.nota}: falta \`${r.missingContext.join(', ')}\` — no se califica_`,
        'no evaluable',
      ].join(' | ') + ' |');
      continue;
    }

    const financiero = r.effects.some(e => FINANCIAL_EFFECTS.has(e.type));
    rows.push('| ' + [
      `\`${c.estado}\``,
      fmtTags(c.tags),
      `\`${r.nextState}\``,
      r.continueConversation ? 'sí' : '**no**',
      r.matchedRule ? `\`${r.matchedRule}\`` : '_(acumulador)_',
      fmtCtx(r.ctxUpdates),
      fmtEffects(r.effects) + (c.nota ? `<br>_${c.nota}_` : ''),
      financiero ? '**💰 SÍ**' : 'no',
    ].join(' | ') + ' |');
  }

  const ejemplo = (() => {
    const d = resolveStateTransition('agendando', [tag('CITA_CONFIRMADA')]);
    return JSON.stringify({
      nextState: d.nextState,
      continueConversation: d.continueConversation,
      ctxUpdates: d.ctxUpdates,
      effects: d.effects,
      matchedRule: d.matchedRule,
    }, null, 2);
  })();

  return `# Matriz de transiciones — producción vs evaluación

> **Archivo generado.** Sale de \`eval/state-spec.js\` vía \`node eval/docs.js\`.
> No lo edites a mano: regeneralo después de tocar el spec.

Espeja \`webhooks/ghl.js:141-420\`, verificado el 2026-08-05.

## La función compartida

\`resolveStateTransition(estado, tags, ctx)\` es **pura**: devuelve una decisión
declarativa y no ejecuta nada. Producción ejecutaría esos efectos; la evaluación
los **simula y califica**.

\`\`\`
state-spec.js → resolveStateTransition()
                     ↓                    ↓
             webhooks/ghl.js        eval/replay.js
             EJECUTA efectos        SIMULA y califica
\`\`\`

Ejemplo de decisión (\`agendando\` + \`[CITA_CONFIRMADA]\`):

\`\`\`json
${ejemplo}
\`\`\`

## Reglas

### Etapa 1 — acumulador (todas las que matcheen, en orden; gana la última)

| Tag | Estado | Ref |
| --- | --- | --- |
${ACCUMULATOR.map(r => `| \`${r.tag}\` | ${r.estado ? `\`${r.estado}\`` : '_no avanza_'} | \`${r.ref}\` |`).join('\n')}

### Etapa 2 — ramas de retorno temprano (gana la PRIMERA)

| # | Tag | Estado | ¿Sigue? | Ref |
| --- | --- | --- | --- | --- |
${BRANCHES.map((b, i) => `| ${i + 1} | \`${b.tag}\` | ${b.estado ? `\`${b.estado}\`` : '_conserva acumulador_'} | ${b.continues ? 'sí' : 'no'} | \`${b.ref}\` |`).join('\n')}

Estados terminales: ${TERMINAL_ESTADOS.map(e => `\`${e}\``).join(', ')}.

Efectos financieros: ${[...FINANCIAL_EFFECTS].map(e => `\`${e}\``).join(', ')}. Un solo
falso positivo de \`[CITA_CONFIRMADA]\` bloquea la migración: crea un link de pago de
Wompi y una fila en \`pending_payments\` que alguien tiene que deshacer a mano.

---

## Matriz de casos

| Estado inicial | Tags emitidos | Estado final | ¿Sigue el replay? | Regla ganadora | Cambios de contexto | Efectos externos | ¿Riesgo financiero? |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

---

## Cinco ejes independientes

Un modelo puede emitir **los tags correctos** y aun así terminar en el estado
equivocado, porque la combinación y la precedencia deciden el desenlace.
\`replay.js\` compara \`resolveStateTransition(estado, tagsDelModelo)\` contra
\`resolveStateTransition(estado, tagsDelGold)\` y reporta:

| Eje | Qué falla cuando falla |
| --- | --- |
| \`tags\` | emitió el tag equivocado, inventó uno, u omitió el requerido |
| \`estado\` | los tags eran correctos pero la combinación llevó a otro estado |
| \`ctx\` | el payload faltó o vino mal, y los prompts siguientes se arman incompletos |
| \`efectos\` | disparó o se saltó una acción externa |
| \`financiero\` | **cobró cuando no debía, o no cobró cuando debía** — gate propio |
`;
}

const out = path.join(__dirname, 'MATRIZ.md');
fs.writeFileSync(out, render());
console.log(`Escrito ${out} — ${CASES.filter(c => !c.seccion).length} casos`);
