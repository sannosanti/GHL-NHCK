# Entrega congelada para auditoría — harness de evaluación NHC / NHC Kids

**Commit congelado: `0d47ffc884e71a7d303eea33712547d19402c5fe`**
Rama `main` · 2026-08-05 13:12:18 -0500 · padre `d70be1aa`

Esta versión no se modifica hasta que termine la auditoría. Los hallazgos se
anotan contra los hashes de abajo; cualquier corrección va en un commit posterior
que los referencie.

---

## 1. Hash exacto

| Objeto | Hash |
| --- | --- |
| Commit congelado | `0d47ffc884e71a7d303eea33712547d19402c5fe` |
| Árbol de `eval/` | `git rev-parse 0d47ffc:eval` |
| Commit padre | `d70be1aad6400f759d1227bc1d2709625c6dde22` |

Verificación:

    git show --stat 0d47ffc
    git ls-tree -r 0d47ffc -- eval

### Línea de base de la auditoría #1 (INVENTARIO contra ghl.js)

`webhooks/ghl.js` **no** entró en este commit y su copia de trabajo difiere de
HEAD. El inventario se construyó leyendo la copia de trabajo, así que la
auditoría tiene que usar ésa:

| Versión | Blob |
| --- | --- |
| Copia de trabajo (**línea de base del inventario**) | `3f8116fe7d7292008eb78c95fa939b2a589becfd` |
| HEAD / `d70be1aa` | `d48f4bc281dc4445ee122e8a950c16b20ae4ca20` |

    git cat-file -p 3f8116fe7d7292008eb78c95fa939b2a589becfd   # lo que auditó el inventario

La diferencia son 19 líneas añadidas de trabajo de producción ajeno al harness
(`LINEA_TAG` y una llamada a `ghl.addTag` en el primer mensaje entrante). Ver
§10, hallazgo D-1.

---

## 2. Diff completo

`eval-harness-FROZEN.patch` — 8.379 líneas, 28 archivos, +8.201 / −2.

Reproducible exactamente:

    git show 0d47ffc

Corresponde a los 285 tests de §9.

---

## 3. Árbol — 26 archivos

**Son 26, no 27.** El «27» venía del patch `eval-diff-v10` de la ronda 9, que ya
no corresponde a este estado (ver §10, hallazgo D-2). Con `.gitignore` y
`package.json`, el diff toca 28 archivos.

    eval/
    ├── README.md                          605   guía de uso y protocolo
    ├── ENTREGA.md                           —   este documento
    │
    ├── state-spec.js                            CONTRATO compartido: resolveStateTransition()
    ├── effects.js                               simulador de efectos (importa solo state-spec)
    ├── replay.js                                replay autoregresivo / teacher-forced
    ├── graders.js                               calificadores por eje
    ├── stats.js                                 wilson, cluster bootstrap, paired bootstrap, mcnemar
    ├── run.js                                   agregación, comparación pareada, gates, costos
    ├── adapters.js                              Anthropic / OpenAI
    ├── preflight.js                             aislamiento de entorno
    │
    ├── extract-lib.js                           TODA la lógica pura del extractor
    ├── extract-dataset.js                       única parte que depende de PostgreSQL
    ├── estimate-cost.js                         proyección de costo de la corrida
    ├── docs.js                                  genera MATRIZ.md
    │
    ├── verify-adapters.js                       smoke test de adapters (NO ejecutado)
    ├── verify-readonly-db.js                    verificación de permisos (NO ejecutado)
    │
    ├── readonly-role.sql                  106   VIGENTE — intacto, sin tocar
    ├── readonly-role.PROPUESTA.sql        967   PROPUESTA — sin aplicar
    │
    ├── PARIDAD.md                         206   contrato de paridad y plan de refactor
    ├── INVENTARIO.md                      163   efectos externos de ghl.js, 11 categorías
    ├── MATRIZ.md                          169   matriz de transiciones (generada por docs.js)
    │
    ├── graders.test.js                     48 tests
    ├── pipeline.test.js                    27 tests
    ├── extract.test.js                     70 tests
    ├── webhook-parity.test.js             140 tests
    ├── predicates.integration.test.js           requiere base; NO corre en la suite
    └── webhook-baseline.json               59   línea de base de paridad

`eval/gold/` y `eval/out/` están en `.gitignore` y **no existen todavía**.

### SHA-256

Ver `MANIFEST-sha256.txt`. Los cinco que más importan para la auditoría:

    12b9b318323ce85f164b9765648238a428c124cdeab22ff92ea7d300e0808fae  eval/extract-lib.js
    d161ea4a54cbbba5227ceb87811cc9484e13fbde8767f33ff1197a896d9e924d  eval/state-spec.js
    74e4313248cd4d6a45d7829b18b33c9fe5660a03538e83b85dc283589ffb7f5a  eval/readonly-role.PROPUESTA.sql
    0b7a504a6d44fb429dfa4a2ec708b29fcffaaa351de7042bccf9e0277e7d8eee  eval/PARIDAD.md
    dc515a68a1f45ea5f84753fc84f196ef8ec7a9cfa92b35a0ace8cf35eb3b76c7  eval/INVENTARIO.md

---

## 4–7. Documentos

| # | Archivo | Líneas | Estado |
| --- | --- | --- | --- |
| 4 | `eval/readonly-role.PROPUESTA.sql` | 967 | **sin aplicar**, nunca ejecutado |
| 5 | `eval/PARIDAD.md` | 206 | — |
| 6 | `eval/INVENTARIO.md` | 163 | contra el blob `3f8116fe` |
| 7 | `eval/MATRIZ.md` | 169 | generado por `docs.js` |

Estructura verificada del SQL (§10 L-3 aclara el alcance de «verificado»):
`$$` balanceados (28), un `BEGIN;` y un `COMMIT;`, 14 bloques `DO` cerrados, cero
DDL fuera de la transacción, cero `RAISE` con `%s`, y toda la auditoría `0.x`
(hasta la línea 355) precede al primer DDL (línea 422).

---

## 8. Comando de la suite

    npm run test:eval

Que es exactamente:

    node eval/graders.test.js && node eval/pipeline.test.js && node eval/extract.test.js && node eval/webhook-parity.test.js

`predicates.integration.test.js` **no** está en la suite: requiere una conexión a
PostgreSQL, y correrlo violaría la restricción de no conectar bases.

---

## 9. Salida de la suite

`test-output.txt` — 362 líneas, `exit=0`.

| Archivo | Tests |
| --- | --- |
| `graders.test.js` | 48/48 OK |
| `pipeline.test.js` | 27/27 OK |
| `extract.test.js` | 70/70 OK |
| `webhook-parity.test.js` | 140/140 OK |
| **Total** | **285/285** |

Ningún test toca la red, ninguna base ni ninguna clave. `extract.test.js` usa un
cliente falso que registra los savepoints en memoria.

---

## 10. Limitaciones conocidas y bloqueantes

### BLOQUEANTES — impiden una migración real

**B-1 · Producción y evaluación tienen implementaciones separadas.**
`webhooks/ghl.js` no consume `resolveStateTransition()`. La paridad se sostiene
copiando la lógica a mano y verificándola con 140 tests contra
`webhook-baseline.json`. Un cambio en el webhook desincroniza el harness **sin
que nada lo detecte**. El harness sirve para evaluación exploratoria; no
constituye paridad garantizada. Plan de refactor en `PARIDAD.md`.

**B-2 · El SQL nunca se ejecutó.** Los 14 bloques `DO` de
`readonly-role.PROPUESTA.sql` están verificados por lectura y por chequeos
estructurales de texto, no por PostgreSQL. Cero de ellos corrió. Riesgo
concentrado en: `indkey[0]`/`indkey[1]` sobre `int2vector`, `to_regrole` con rol
inexistente, la consulta a `pg_shdepend`, y el `format()` con `FILTRO_BASE`
dentro de `EXECUTE`.

**B-3 · Los adapters nunca se ejecutaron.** Los ids de Luna y Terra, el endpoint
`/v1/chat/completions`, `max_completion_tokens`, la forma de
`choices[0].message.content` y `usage.prompt_tokens_details.cached_tokens` son
**hipótesis sobre la superficie de GPT-5.6**. `verify-adapters.js` existe
justamente para refutarlas y no se corrió.

**B-4 · No hay dataset.** `eval/gold/` no existe. Los 285 tests corren sobre
fixtures sintéticos. Ningún número de este harness proviene todavía de una
conversación real.

**B-5 · `(agent, conversation_id)` sigue siendo una hipótesis.** Viene de
`recoveryJob.js:205`. La guarda 0.3 del SQL hace fallar la transacción si es
falsa, pero esa guarda no se ejecutó (ver B-2).

### IMPORTANTE — a resolver, no bloqueante para auditar

**I-1 · El gate de recall clínico puede no tener poder.** `MIN_CLINICAL_POSITIVES`
= 60, derivado de la regla de tres. Con 13/2123 conversaciones llegando a
`triaje_completo`, hay que confirmar que el estrato clínico alcanza ese número
antes de creerle al gate.

**I-2 · La contraseña del SQL es un literal.** `'CAMBIAR_ESTA_CLAVE'`. Si alguien
aplica el archivo sin editarla, el rol queda con una contraseña conocida y
publicada en el repo.

### DISCREPANCIAS de esta entrega

**D-1 · `webhooks/ghl.js` tiene un cambio de producción sin commitear**, ajeno al
harness: `LINEA_TAG` + `ghl.addTag(contactId, LINEA_TAG)` en el primer mensaje
entrante (19 líneas). **No lo incluí en el commit de congelamiento** para no
mezclar alcances. Dos consecuencias: la línea de base del inventario es el blob
`3f8116fe` y no HEAD; y ese `addTag` es un efecto externo saliente, ya declarado
como no modelado en `INVENTARIO.md:152`. También quedan sin commitear
`scripts/backfill-linea-tags.js` y `headers.txt`.

**D-2 · El diff v10 quedó obsoleto.** Pediste «el diff correspondiente a los 285
tests»: es `eval-harness-FROZEN.patch` (8.379 líneas). El `eval-diff-v10.patch`
de la ronda 9 correspondía a 267 tests y 7.204 líneas. Igual que el conteo de
archivos (26, no 27), la cifra anterior ya no aplica.

### LIMITACIONES ACEPTADAS

**L-1 · Pérdida del `undefined` por fila en `has_pending`.** Aceptada bajo las
cuatro condiciones documentadas al pie del SQL: consulta atómica, `true`/`false`
como conocimiento real vía `EXISTS`, indisponibilidad completa reflejada en
`pending_payment_disponible`, y ese metadato bloqueando el gate financiero. La
ignorancia se representa a nivel de CORRIDA, no de fila.

**L-2 · Los escaneos estáticos no prueban imposibilidad universal.** La barrera 3
(escaneo de imports y llamadas) demuestra que en este árbol de archivos no hay
ruta a `generarLinkPago`, `savePendingPayment` ni Wompi. No demuestra que ninguna
configuración concebible pueda cobrar. Las barreras 1 (estructural) y 2
(credenciales ausentes) son las que sostienen la afirmación fuerte.

**L-3 · «SQL verificado» significa verificado por lectura.** Los chequeos de §4–7
son de texto: balanceo, conteo y orden. No sustituyen una ejecución. Ver B-2.

**L-4 · `pg_stat_activity` es evidencia parcial.** La sección 0.5 no puede saber
qué usuario usa cada servicio: eso vive en la `DATABASE_URL` de Railway. Un
servicio detenido no aparece. Emite NOTICE, no EXCEPTION, y lo dice.

**L-5 · `pg_shdepend` no cubre identidad de conexión.** La sección 0.6 detecta
objetos y ACLs de los roles en otras bases del clúster. No detecta que otro
sistema se conecte usando `nhc_eval_ro`: recrearlo cambia la contraseña y lo
dejaría afuera. Declarado en el bloque.

**L-6 · Umbral de 500.000 filas: política preventiva.** No es una frontera
técnica de PostgreSQL. Combina tamaño estimado, índice servible y
`statement_timeout`, y los imprime para que la decisión sea consciente.

**L-7 · El scrub automático NO redacta nombres.** Cubre teléfonos, emails y URLs.
Los nombres exigen un paso manual, y `validateGold()` rechaza el dataset mientras
`_needs_name_redaction` siga en `true`.

**L-8 · Efectos fuera de la ruta de decisión por tags.** `INVENTARIO.md:143-163`
los declara: comprobante de pago por imagen, transcripción de audio, `LINEA_TAG`,
cola de webhooks, callbacks de timers, retoma desde `estado_antes_cierre`,
`notifyError`. El harness solo ejercita `resolveStateTransition()`, no el handler.

**L-9 · Los `*.test.js` están exentos del escáner de fugas (test 10g).** Sus
errores son fallas de `assert` sobre fixtures sintéticos y su mensaje ES el
resultado del test. La exención se apoya en que ninguno entra en el grafo de
`require` de `run.js` ni de `extract-dataset.js`.

**L-10 · Simplificaciones declaradas del spec.** `SAVE_SYMPTOM` no modela el
mapeo de categorías de cada mapper; `SEND_MESSAGE` modela que se envía, no el
contenido (el contenido se califica en el eje `flow` y en el blind rating).

---

## Restricciones vigentes hasta cerrar la auditoría

No aplicar SQL · no crear roles · no conectar bases · no ejecutar adapters · no
correr piloto · no modificar producción · no regenerar el diff.
