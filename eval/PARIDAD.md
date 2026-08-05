# Paridad entre producción y evaluación

Cómo se garantiza que la evaluación mida el sistema que realmente corre, y qué
falta para cerrarlo del todo.

## El problema

Sin una función compartida hay **tres implementaciones** de la misma lógica:

1. el ruteo real en `webhooks/ghl.js` (acumulador + ramas con retorno temprano);
2. una copia en el harness;
3. la interpretación que el replay hace de esa copia.

Las tres pueden divergir de a pares. La primera versión de este harness divergía en
cinco puntos —incluido `[TRIAJE_P3]` sin `[TRIAJE_COMPLETO]`, que habría ocultado un
bloqueo real del embudo— y nadie se enteró hasta leer el webhook línea por línea.

## Estado actual

```
                    eval/state-spec.js
                 resolveStateTransition()          ← función pura, no ejecuta nada
                            ↓
                    eval/replay.js
                 SIMULA efectos y califica

     webhooks/ghl.js  ← TODAVÍA tiene su propia lógica (pendiente)
     EJECUTA efectos
```

Lo que ya está cerrado: (2) y (3) son la misma función. La matriz, las transiciones,
los graders y los tests consumen `resolveStateTransition()`; ya no pueden
contradecirse entre sí.

Lo que falta: (1). Producción sigue con su propia copia.

## Los tres niveles de verificación

| Nivel | Qué prueba | Qué NO prueba | Dónde |
|---|---|---|---|
| **1 — Alarma de deriva** | Que un bloque de `webhooks/ghl.js` cambió | Que el spec siga describiéndolo bien | `webhook-parity.test.js` nivel 1 |
| **2 — Contrato semántico** | El comportamiento de `resolveStateTransition()` sobre las combinaciones donde la precedencia decide | Que producción use esa función | nivel 2 |
| **3 — Seguridad financiera** | Que `eval/` no puede importar ni invocar efectos reales | — | nivel 3 |

El nivel 1 es una **alarma**, no una prueba de equivalencia. Hashea el fuente
normalizado de cada rama (sin comentarios, sin espacios) y falla con:

```
Cambió el bloque de producción relacionado con CITA_CONFIRMADA
(webhooks/ghl.js:190, antes L190); revisar y actualizar state-spec.js.
```

Tolera reformateos y cambios de comentarios; **no** tolera cambios de lógica. Un
falso positivo por un cambio cosmético cuesta una lectura de diff. Un falso negativo
costaría una evaluación entera hecha contra un sistema que ya no existe.

Después de revisar un cambio intencional:

```bash
node eval/webhook-parity.test.js --update
```

Regenerar el baseline **sin** revisar el spec convierte la alarma en ruido y anula
todo el nivel 1.

## Lo que falta: refactor semántico de producción

**Requisito bloqueante antes de migrar de modelo.** Mientras no exista, la evaluación
mide una *reimplementación fiel y verificada por hash* del ruteo, no el ruteo.

No se hizo en este PR a propósito: `webhooks/ghl.js` es el camino que crea links de
pago reales, y tocarlo necesita su propio plan de despliegue en dos servicios de
Railway (uno con el webhook de GitHub roto, que exige `railway up`). Mezclar ese
riesgo con un harness de evaluación es empaquetar dos cosas que no se parecen.

### Plan en tres etapas

**Etapa 1 — mover el spec fuera de `eval/`.** `resolveStateTransition()` deja de ser
código de evaluación y pasa a ser código compartido.

```
lib/state-spec.js          ← movido tal cual, sin cambios
eval/state-spec.js         ← re-export: module.exports = require('../lib/state-spec')
```

Sin riesgo: nada de producción lo importa todavía.

**Etapa 2 — ejecutor de efectos en producción.** Un módulo nuevo que traduce cada
descriptor a la llamada real que hoy está inline en el webhook:

```js
// services/effect-runner.js
async function runEffects(effects, ctx) {
  for (const e of effects) {
    switch (e.type) {
      case EFFECT.ADD_TAG:                  await ghl.addTag(ctx.contactId, e.tag); break;
      case EFFECT.CREATE_WOMPI_PAYMENT:     await pagos.generarLinkPago({ ...ctx, monto: e.amount }); break;
      case EFFECT.INSERT_PENDING_PAYMENT:   await db.savePendingPayment(ctx.referencia, ctx.datos); break;
      // ...
    }
  }
}
```

Se puede escribir y testear **sin tocar el webhook**: el test compara, para cada
combinación de la matriz, que `runEffects` emita la misma secuencia de llamadas que
hoy hace el webhook, con los mocks de `ghl`/`pagos`/`db`.

**Etapa 3 — el webhook consume la decisión.** Recién acá cambia producción:

```js
const decision = resolveStateTransition(estado, parseTags(rawReply), { derivadoA });

await runEffects(decision.effects, { contactId, conversationId, ... });
await db.saveConversationData(conversationId, contactId, history, nuevoTriaje, decision.nextState, null, phone);
if (!decision.continueConversation) return;
```

**No es un diff de 15 líneas.** Reemplaza ~270 líneas (`ghl.js:141-413`) donde hoy la
decisión y la ejecución están entretejidas: cada rama arma su propio texto, empuja al
historial y llama a `sendMessages` antes de retornar. Separar decisión de ejecución
significa reordenar todo eso.

Criterio de aceptación de la etapa 3: la suite completa en verde, el nivel 1
regenerado tras revisión, y **shadow mode** (§9 del README) corriendo dos semanas
sobre `[CITA_CONFIRMADA]` antes de considerarlo estable — es el único efecto que
cobra.

## Seguridad financiera

La formulación correcta, y la única que puedo sostener:

> **Con el código y las dependencias actuales, no existe una ruta de cobro detectada
> desde `eval/`, y la suite bloquea las rutas conocidas.** Los escaneos estáticos no
> demuestran imposibilidad universal.

Lo que un escaneo estático **no** cubre: `require` construido dinámicamente
(`require(variable)`), `eval()`, importación por `child_process`, una dependencia
transitiva que llame a Wompi por su cuenta, o código nuevo escrito después del
último `npm run test:eval`. Nada de eso existe hoy en `eval/`, pero el test verifica
patrones, no ausencia de posibilidad.

Por eso las barreras son tres y no una — ver [INVENTARIO.md](INVENTARIO.md) para el
detalle por efecto:

| Barrera | Qué garantiza |
|---|---|
| **Estructural** | `eval/` nunca importa ni invoca el handler del webhook |
| **Import/llamada** | Escaneo estático de `require` y de llamadas prohibidas |
| **Credencial** | `preflight.js` aborta si hay credenciales de producción en el entorno |

La tercera es la que sigue valiendo aunque las otras dos fallen: sin
`WOMPI_PRIVATE_KEY` en el proceso no hay con qué autenticarse contra la pasarela.

Los mecanismos concretos:

- `effects.js` importa exactamente un módulo: `./state-spec`, que es puro. Un test lo
  verifica sobre el AST de requires.
- Todo efecto que produce el harness es un registro **congelado** con
  `simulated: true` y sin ningún método invocable.
- Dos escaneos estáticos sobre los 15 archivos de `eval/`: uno de imports prohibidos
  (`services/pagos`, `services/ghl`, `services/zoho`, `jobs/`) sobre el fuente con
  strings intactos, y otro de llamadas prohibidas (`generarLinkPago(`,
  `savePendingPayment(`, `sendMessage(`, `addTag(`, …) sobre el fuente con strings y
  regex vaciados.
- Un test inyecta una llamada real y verifica que el guard la detecta — un guard que
  no puede fallar no protege nada.
- Solo `extract-dataset.js` importa `db`, y otro test verifica que todas sus
  consultas son `SELECT`.

Un cobro desde `eval/` requeriría escribir código nuevo **con una forma que el
escaneo reconoce**, y ese código hace fallar la suite. Un `require` dinámico o una
dependencia transitiva escaparían al escaneo — ahí la barrera que queda es la
credencial ausente.

## Gate financiero: tres rutas, no una

Cubre **todos** los efectos financieros resueltos, no un tag:

| Ruta | Rama | Efecto |
|---|---|---|
| Cita confirmada | `[CITA_CONFIRMADA]` | link Wompi + `pending_payments` |
| Segundo link | `[MEDIO_WOMPI]` en `esperando_pago` (`ghl.js:275`) | link Wompi |
| Datos bancarios | `[MEDIO_TRANSFERENCIA]` / `[MEDIO_QR]` | publica cuenta y llave reales |

La primera versión del gate miraba solo `[CITA_CONFIRMADA]` y dejaba las otras dos
sin cubrir.

## Gate financiero

`[CITA_CONFIRMADA]` tiene su propia matriz, separada de "tags correctos" y "estado
correcto", porque un falso positivo no es una métrica: es un cobro y una fila en
`pending_payments` que alguien deshace a mano.

| Esperado | Emitido | Resultado |
|---|---|---|
| Confirmar cita | Sí | TP |
| Confirmar cita | No | FN |
| **No confirmar** | **Sí** | **FP financiero** |
| No confirmar | No | TN |

El denominador es **todo turno**, no solo los de agendamiento: un
`[CITA_CONFIRMADA]` espurio puede aparecer en cualquier punto de la conversación.

**Un solo FP financiero bloquea la migración.** El informe además lista cada uno con
su estado de entrada, los tags que lo produjeron y los efectos simulados.
