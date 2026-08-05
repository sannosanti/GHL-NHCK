# Adenda al inventario de efectos — `LINEA_TAG`

**Por qué es una adenda y no una edición.** `eval/INVENTARIO.md` está dentro del
commit congelado `0d47ffc` y no se toca. Esta fila se entrega por separado y debe
leerse como parte del inventario durante el paso 1 de la auditoría. Cuando se
levante el congelamiento, se integra a la tabla de efectos de `INVENTARIO.md`.

Aplica al baseline `audit/ghl.js.baseline` (blob `3f8116fe`), que es el archivo
contra el que se construyó el inventario.

---

## La fila

| Efecto | Disparador | Líneas | Destino | Riesgo | Modelado en `state-spec.js` | Alcanzable desde `eval/` | Barrera |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ghl.addTag(contactId, LINEA_TAG)` | `!convData` — primera conversación del contacto | decl. 29–39 · efecto 520–527, con la llamada en **525** | **GHL** (escritura saliente, API externa) | Bajo | **NO** | No · E+I+C | nivel 2 |

Valor del tag: `linea-nhc` si `env.agentName === 'luisa'`, si no `linea-nhck`.

Formato de columnas igual al de la tabla de `INVENTARIO.md`. «E+I+C» = las tres
barreras: Estructural, Import-call, Credencial.

---

## Disparador: `!convData`, no un tag

Ésta es la propiedad que decide todo lo demás.

    if (!convData) {
      ghl.addTag(contactId, LINEA_TAG).catch(() => {});
    }

`convData` viene de `getConversationData()`, inmediatamente antes. Es falsy cuando
**no hay fila previa** para esa conversación: primer mensaje entrante de ese
contacto.

La condición no mira `estado`, ni el texto del paciente, ni ningún tag emitido por
el modelo. Se evalúa **antes** de que el modelo haya sido llamado siquiera. Por
eso `resolveStateTransition()` no puede alcanzarla: esa función recibe
`(estado, tags, ctx)` y devuelve transiciones y efectos derivados de tags. Un
efecto que se dispara por ausencia de fila en base no tiene entrada en ese
contrato.

---

## No modelado en `state-spec.js`

Confirmado. `LINEA_TAG` no aparece en `eval/state-spec.js` ni en `eval/effects.js`,
y no existe un `EFFECT.*` que lo represente. Está declarado como omisión en
`INVENTARIO.md:152`, bajo *Efectos que `state-spec.js` NO modela → Fuera de la
ruta de decisión por tags*:

> reactivación de contacto (`activo nhck`, `LINEA_TAG`)

Esta adenda no cambia esa clasificación: la sube de una línea en una lista de
omisiones a una fila con disparador, líneas, destino y justificación, que es lo
que corresponde a una escritura saliente hacia un sistema externo.

---

## ¿Afecta la comparación de modelos?

**No.** Tres razones independientes, y alcanza con cualquiera:

**1 · No está en la ruta que el harness ejercita.** El harness llama
`resolveStateTransition()` y `simulateEffects()`. Nunca invoca
`ghlWebhookHandler`, que es donde vive la línea 525. El código no se ejecuta
durante una evaluación, con ningún modelo.

**2 · El modelo no puede influir en el disparador.** `!convData` es una propiedad
del estado de la base antes del turno. Sonnet, Luna y Terra reciben exactamente el
mismo `convData` en el mismo punto del flujo; ninguna salida del modelo puede
hacer que la condición cambie. Un efecto que los tres disparan idéntico, o que
ninguno dispara, no puede producir diferencia entre ellos — que es lo único que la
evaluación mide.

**3 · No entra en ningún eje de calificación.** Los ejes son `tags`, `flow`,
`estado`, `ctx`, `efectos`, `financiero`, `escalation`, `escalation_hygiene`. El
eje `efectos` compara los efectos **resueltos por el spec**, y `LINEA_TAG` no
produce ninguno. No hay métrica donde pueda aparecer como acierto ni como fallo.

### Lo que sí hay que registrar

Es una **escritura saliente hacia GHL**, así que pertenece al inventario de
efectos por completitud aunque no afecte la comparación. Dos consecuencias
prácticas:

- **Si algún día el harness ejercitara el handler completo** en vez del resolver
  —cosa que hoy no hace y que el refactor de `PARIDAD.md` haría posible— esta
  llamada pasaría a ser alcanzable y necesitaría barrera propia. Hoy la barrera
  que la contiene es estructural: el handler no se importa.
- **La barrera de nivel 2** (escaneo de imports y llamadas de `eval/`) cubriría
  `ghl.addTag` si alguien lo importara desde el harness, igual que cubre los otros
  `addTag` ya inventariados.

---

## Qué queda para la auditoría

Esta adenda documenta el efecto; no cierra la decisión. Lo que el paso 1 tiene
que resolver es si el criterio actual de `INVENTARIO.md` —«fuera de la ruta de
decisión por tags» como categoría de omisión— es el corte correcto, o si toda
escritura saliente hacia un sistema externo debería tener fila propia
independientemente de qué la dispare. Si es lo segundo, hay que revisar con el
mismo criterio los demás elementos de la lista de `INVENTARIO.md:150-156`:
comprobante de pago por imagen, transcripción de audio, cola de webhooks,
callbacks de timers, retoma desde `estado_antes_cierre` y `notifyError`.
