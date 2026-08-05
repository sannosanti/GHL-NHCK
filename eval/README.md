# Protocolo de evaluación — ¿puede Luna o Terra reemplazar a Sonnet 4.5 en NHC?

Objetivo: decidir con datos, no con benchmarks públicos, si `GPT-5.6 Luna` o
`GPT-5.6 Terra` pueden reemplazar a `claude-sonnet-4-5` en producción sin degradar
el funcionamiento del sistema NHC / NHC Kids.

---

## 0. Antes de correr nada

Tres cosas bloquean la ejecución. Ninguna es opcional.

| Bloqueante | Qué se necesita |
|---|---|
| Claves de API | `ANTHROPIC_API_KEY` (ya existe) y `OPENAI_API_KEY` (no existe todavía) |
| IDs de modelo | `EVAL_LUNA_MODEL` y `EVAL_TERRA_MODEL` con el string exacto de la doc de OpenAI. **No se adivinan**: un id inválido devuelve 404 y se lee como falla de capacidad |
| Acceso a Postgres | `DATABASE_URL` para extraer conversaciones reales |

**Transiciones: verificadas el 2026-08-05** contra `webhooks/ghl.js:141-420`. La
primera versión de `transition()` tenía cinco divergencias con producción; están
corregidas y cada una quedó fijada con un test de regresión (27-43 en
`graders.test.js`, con la línea del webhook en el nombre):

| # | Lo que hacía la eval | Lo que hace producción |
|---|---|---|
| 1 | `CIUDAD_VALIDA` avanzaba `nuevo → triaje_p1` | No cambia estado (`ghl.js:160`). Se emite **dentro** de triaje_p1 |
| 2 | `TRIAJE_P3` avanzaba a `triaje_completo` | No cambia estado (`ghl.js:182`). Solo `TRIAJE_COMPLETO` avanza |
| 3 | `POSPONER` → estado `'pospuesto'` | Estado sin cambios; escribe `recovery_status` (`ghl.js:404`). **No existe** un estado `pospuesto` |
| 4 | `NHC_ADULTOS` sin manejar | → `triaje_p1` + `derivadoA='luisa'` (`ghl.js:370`), y la conversación **sigue** |
| 5 | `ESCALAR` ganaba sobre todo | Los cierres y `NHC_ADULTOS` retornan **antes** (`ghl.js:322/336/350/366` vs `381`) |

Producción resuelve el estado en dos etapas: un **acumulador** (`ghl.js:141-187`)
que avanza con los tags de triaje, y una cadena de **retornos tempranos**
(`ghl.js:190-413`) donde gana la primera rama en orden de archivo y sobrescribe al
acumulador. `transition()` ahora replica ambas.

⚠️ Si cambia el ruteo en `webhooks/ghl.js`, esta tabla queda desactualizada y la
eval vuelve a medir un sistema que no existe. Los tests de regresión lo detectan
solo si alguien los corre.

---

## 1. Dos decisiones de método que definen si el resultado sirve

### El baseline no es la fuente de verdad

Si Sonnet es a la vez baseline y ground truth, Sonnet saca 100% por construcción y
la evaluación deja de medir corrección: mide parecido a Sonnet. Un modelo que
corrija un error de Sonnet aparecería como falla.

Por eso la verdad viene de un **gold set etiquetado a mano**, derivado de las
reglas del prompt, no de lo que Sonnet respondió. Sonnet es el punto de
comparación —el listón que hoy funciona en producción— y se lo mide con la misma
vara que a los candidatos. Es perfectamente posible que Sonnet no saque 100%.

### Hay que replayar la máquina de estados, no el prompt

`buildSystemPrompt(estado, ctx)` devuelve un prompt **distinto por estado**
(`nuevo`, `triaje_p1`, `triaje_p2`, `triaje_p3`, `triaje_completo`, `agendando`,
`escalado`, `esperando_pago`), y el estado avanza según los tags que el modelo
emite.

Consecuencia: no se puede evaluar mandando un prompt fijo contra un transcript. Un
modelo que omite `[TRIAJE_P1]` nunca llega al prompt de `triaje_p2`, y todos los
turnos siguientes se juzgarían contra instrucciones que nunca recibió.

`replay.js` reconstruye el prompt en cada turno desde el estado actual, llama al
modelo, parsea sus tags, transiciona y sigue. Un modelo que se descarrila se
califica sobre la conversación que realmente produjo — igual que haría producción.

---

## 2. Qué se mide y cómo

Todo lo determinista está en `graders.js` y es reproducible. Nada de eso le
pregunta a un modelo si otro modelo lo hizo bien.

**Tags** (`metric: tags`)
- tags requeridos presentes / prohibidos ausentes (contra el gold set)
- tags inventados: cualquier `[TOKEN]` fuera del vocabulario de 17 tags del prompt.
  Falla dura: el webhook no los rutea y la máquina de estados se congela sin error
- payload vacío: `[TRIAJE_P1:]` escribe una respuesta de triaje vacía en la base
- **fuga al paciente**: se corre `limpiarTags()` y se busca lo que sobrevive. Es el
  test de los dos incidentes reales (2026-07-25 y 2026-07-29), en los que un tag
  llegó por WhatsApp a un paciente

**Escalamiento** (`metric: escalation`) — matriz de confusión, nunca un porcentaje
global.

**Regla de denominador**: un turno entra al cálculo **solo si la etiqueta gold
declara una expectativa de escalamiento** — `ESCALAR` en `tags_required`
(positivo) o en `tags_forbidden` (negativo). Los turnos sin decisión de
escalamiento se **excluyen**, no se cuentan como aprobados. Promediarlos empuja la
tasa hacia 100% y esconde exactamente lo que la métrica existe para atrapar.

|  | Modelo escaló | Modelo no escaló |
|---|---|---|
| **Debía escalar** | TP | **FN** ← la falla clínica |
| **No debía escalar** | FP | TN |

Se reportan por separado:
- **Recall** = TP/(TP+FN). ¿Escala cuando debe? Es el número clínico.
- **Precisión** = TP/(TP+FP). ¿Escala solo cuando debe? Un modelo que escala todo
  satura al equipo comercial.
- **Recall sobre el subconjunto clínico** (autismo/TEA/epilepsia, marcado
  `clinical: true`), con su propio gate de cero omisiones.

Un modelo que **nunca** escala tiene precisión indefinida —nunca 100%— y recall 0.
El test 14 en `graders.test.js` fija ese comportamiento.

**Higiene del escalamiento** (`metric: escalation_hygiene`) — métrica aparte, para
que no contamine la matriz: al emitir `[ESCALAR]` el mensaje no puede contener otra
pregunta y tiene que nombrar la ventana concreta de PRÓXIMO CONTACTO. Decidir bien
y redactar mal son dos fallas distintas.

**Flujo / fidelidad al prompt** (`metric: flow`)
- contenido prohibido: convenios sin que el cliente los mencione, ofrecer envío por
  correo, "asesores humanos", admitir ser IA, marca inventada, "buena tarde",
  asteriscos
- preguntas repetidas (solapamiento ≥ 0.75 contra todas las preguntas previas)
- máximo 2 párrafos
- mezcla de tuteo y voseo en un mismo mensaje

**Consistencia** — cada conversación se corre N veces (default 5). Se mide, por
métrica, cuántas repeticiones coinciden con su propio resultado modal, más si todas
las repeticiones terminan en el mismo `estado` final. Un modelo que acierta el 98%
pero es inestable turno a turno es peor operativamente que uno con 96% estable.

**Costo y velocidad** — tokens reales devueltos por cada API (input / output /
cache), costo por conversación, proyección mensual sobre volumen real, latencia
media y p95.

**Calidad conversacional** — no se puede calificar por regla. Sale en
`blind-rating.md`: las respuestas de los tres modelos, anonimizadas, mezcladas y en
orden aleatorio, con la clave en un archivo aparte. La califica una persona.
No se usa un modelo como juez: una comparación Claude-vs-GPT juzgada por Claude no
es evidencia, es conflicto de interés.

---

**Los dos modos, siempre.** Responden preguntas distintas:

- **`autoregressive`** — *replay autoregresivo con mensajes de usuario fijos.* Las
  respuestas del modelo se realimentan y el estado avanza según los tags que **el
  modelo** emitió, pero el siguiente mensaje del paciente sigue siendo el
  **histórico**, provocado originalmente por otra respuesta.

  Es una **evaluación contrafáctica del sistema, no una simulación de conversación
  humana.** Mide propagación de tags, acumulación de errores, desvío de estados y
  degradación del contexto. **No** dice cómo habría reaccionado el paciente ante una
  respuesta distinta, y un resultado acá no se puede leer como "esto es lo que
  producción habría dicho punta a punta".

- **`teacher_forced`** — el historial es el transcript **real** y el estado y el
  contexto avanzan por el camino gold, payloads incluidos. Cada turno arranca en el
  mismo punto para los tres modelos. Aísla calidad de decisión por turno; ciego a la
  acumulación de errores.

Un modelo que va bien teacher-forced y mal autoregresivo es **frágil, no incapaz** —
y esa distinción cambia si el arreglo es trabajo de prompt o cambiar de modelo.

### Payloads en el gold set

`tags_required` acepta el nombre suelto o el par con payload. **Los tags que
escriben contexto lo necesitan**:

```json
"tags_required": [
  { "name": "NOMBRE_PADRE", "payload": "Ana Gómez" },
  { "name": "TRIAJE_P1",    "payload": "Dificultad para concentrarse" }
]
```

Sin payload el estado avanza igual, pero `updateCtx()` no escribe nada y **todos los
prompts siguientes se arman con nombre vacío y triaje vacío**. El transcript guardado
viene sin tags, así que los payloads no se pueden recuperar de ahí; `extract-dataset.js`
los saca de la columna `triaje` y los deja en `_payload_hints` para que el anotador los
ubique en el turno correcto — a qué turno corresponde cada uno no es recuperable.

## 3. Ejecución

```bash
npm run test:eval                    # 241 tests, sin red ni base
#   graders.test.js          48  graders y máquina de estados
#   pipeline.test.js         21  clustering, pareado, gate, costo, indeterminado
#   extract.test.js          32  estratos, cuotas, frecuencias, anonimización, fuga de ids
#   webhook-parity.test.js  140  deriva del webhook, contrato semántico, seguridad financiera

node eval/docs.js                    # regenera MATRIZ.md desde state-spec.js
node eval/estimate-cost.js           # costo antes de gastar

# Entorno aislado — antes de tocar nada
node eval/preflight.js               # aborta si hay credenciales de producción
psql "$DATABASE_URL" -f eval/readonly-role.sql   # una sola vez, como superusuario
node eval/verify-readonly-db.js      # prueba que el rol rechaza escrituras

node eval/verify-adapters.js         # ⛔ OBLIGATORIO antes de la corrida grande
node eval/extract-dataset.js --agent carolina --out eval/gold/nhck.draft.json
# → etiquetar a mano (ver §7)

node eval/run.js --gold eval/gold/nhck.json --piloto 5 --reps 2 --out eval/out-piloto
node eval/run.js --gold eval/gold/nhck.json --reps 5 --volume 2123 --out eval/out
```

### Entorno aislado

`preflight.js` corre automáticamente al inicio de `extract-dataset.js`,
`verify-adapters.js` y `run.js`, y **aborta** —no advierte— si encuentra
`WOMPI_*`, `GHL_API_KEY`, `ZOHO_*`, `GROQ_API_KEY` o `DATABASE_URL` en el entorno.
Una advertencia dentro de un trabajo de 24.000 llamadas se pierde en el scroll.

La base va por `EVAL_DATABASE_URL` con un rol de **solo lectura a nivel de
permisos**, no por convención del código: `readonly-role.sql` crea `nhc_eval_ro` con
`default_transaction_read_only = on`, `SELECT` únicamente sobre `conversations`, y
sin acceso a `pending_payments` ni `token_usage`. `verify-readonly-db.js` intenta
cinco escrituras y espera que las cinco sean rechazadas por PostgreSQL.

### Piloto antes de la corrida completa

`--piloto N` toma N conversaciones por estrato. Con `--piloto 5 --reps 2` son ~70
conversaciones y ~$5, y sirve para validar formato de salida, costos reales, caché,
manejo de errores y los archivos generados.

El informe del piloto marca explícitamente que **el veredicto del gate no es
concluyente**: la muestra es insuficiente por diseño y el gate clínico va a fallar
por poder estadístico, que es el comportamiento correcto.

`run.js` **aborta** si alguna conversación no tiene `_labeled: true`.

`verify-adapters.js` hace seis llamadas reales y valida id de modelo, endpoint,
formato de instrucciones, campos de salida, parámetros de tokens, forma del `usage`,
reporte de caché y clasificación de errores. Sin eso, un id de modelo equivocado
devuelve 404, el turno se puntúa como "no emitió el tag" y el informe concluye que
el modelo no sabe seguir el prompt. Toda falla de adapter se reporta como
`integration_error`, nunca como falta de capacidad.

El muestreo es estratificado a propósito: una muestra uniforme de 2123
conversaciones es ~99% abandonos tempranos y no prueba casi nada.

### Distribución del dataset

| Estrato | Cuota | Criticidad | Qué prueba |
|---|---|---|---|
| `escalado_clinico` | 80 | **Clínica** | autismo/TEA/Asperger/epilepsia/convulsiones → debe escalar |
| `no_escalar_clinico` | 40 | **Clínica** | TDAH/ansiedad/crónico → **NO** debe escalar (regla del 2026-08-04) |
| `escalado_otro` | 25 | Operativa | pide llamada, falla de agenda |
| `precio` | 20 | Comercial | objeción de precio, convenios |
| `triaje_completo` | 13 | Comercial | las únicas que llegaron al agendamiento |
| `happy_path` | 15 | Comercial | triaje sin fricción |
| `pospuesto` | 10 | Operativa | recovery |
| **Total** | **203** | | |

Las cuotas están dimensionadas por el **poder que cada gate necesita**, no por
frecuencia en producción.

### Tamaño mínimo de muestra

El gate clínico es "cero omisiones". Por la **regla de tres**, observar 0 fallas en
n intentos solo acota la tasa real de fallas en ~3/n:

| n (puntos de decisión clínicos positivos) | Cota superior al 95% |
|---|---|
| 25 | 12% ← inútil para un gate clínico |
| 60 | 5% |
| 150 | 2% |

Por eso `escalado_clinico` tiene cuota 80 (≥60 puntos positivos esperados), y
`run.js` **imprime una advertencia explícita** si el gold set etiquetado queda por
debajo de 60. Un "100% de recall" con n=25 no es evidencia, es ruido.

### La unidad de independencia es la conversación

Cada conversación se replaya N veces. Esas N corridas están **fuertemente
correlacionadas** — mismo prompt, mismos mensajes, mismo modelo. Poolearlas como N
observaciones independientes infla la muestra por N y angosta cada intervalo por
~√N. Por eso:

- las métricas se **agregan primero por conversación** (`toClusters`);
- los intervalos salen de **bootstrap clusterizado** resampleando conversaciones
  enteras, no turnos ni repeticiones;
- la variación entre repeticiones se reporta aparte, como **consistencia**;
- los positivos clínicos se cuentan **una vez por conversación**: replayar cinco
  veces el mismo caso de autismo no crea cinco pacientes.

### La comparación es pareada

Los tres modelos responden exactamente los mismos casos. Comparar dos intervalos
marginales y ver si se solapan tira ese diseño a la basura: es menos potente y puede
declarar "no demostrado" solo porque ambos intervalos son anchos.

Contra el baseline se reporta:

- **McNemar exacto** sobre el resultado binario por conversación. Solo informan los
  **pares discordantes** — dónde uno acierta y el otro falla.
- **Bootstrap pareado** para la diferencia de tasas, evaluando ambos modelos sobre
  las mismas conversaciones resampleadas en cada iteración.
- El **IC de la diferencia** (`Luna − Sonnet`, `Terra − Sonnet`). Si excluye 0, la
  diferencia es real.
- La **lista de conversaciones discordantes**, porque la pregunta útil no es solo si
  un modelo supera un umbral sino en qué casos concretos falla el otro.

### Costo de correr la evaluación

`node eval/estimate-cost.js` lo calcula con supuestos explícitos y auditables:

```
203 conversaciones × 4 turnos × 5 reps × 2 modos = 8.120 llamadas por modelo
                                                  24.360 llamadas totales

Sonnet 4.5   $0.005520/llamada  →  $44.82
Luna         $0.000392/llamada  →   $3.18
Terra        $0.003920/llamada  →  $31.83
TOTAL                              $79.84
+20% margen                        $95.80
```

El supuesto que más mueve el número es `turns` (±$20 por turno). Se recalibra con
`--turns` una vez que exista el draft del gold set.

---

## 4. Compatibilidad técnica — qué habría que tocar

La buena noticia primero: **toda la arquitectura pasa por un solo cuello de
botella**, `callClaude()` en `ai/claude.js`. No usan streaming, ni tool use, ni
extended thinking. Eso hace el swap mecánicamente barato.

| Archivo | Cambio | Esfuerzo |
|---|---|---|
| `ai/claude.js` | Endpoint, headers (`x-api-key` → `Authorization: Bearer`), body (`system` top-level → mensaje `role: system`; `max_tokens` → `max_completion_tokens`), parseo (`data.content[0].text` → `data.choices[0].message.content`), forma del error, y el mapeo de `usage` (4 campos Anthropic → `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`). El bloque `cache_control` desaparece | 2-3 h |
| `db` · `logTokenUsage` + tabla `token_usage` | OpenAI no tiene `cache_creation`. Convención para la columna + asegurar que el costo se calcule por el `model` de cada fila, no con una tarifa fija (si no, las filas históricas de Sonnet se re-tarifan mal) | 1 h |
| `analytics/tokens.js` | Precios por modelo en el dashboard de facturación | 1-2 h |
| `config` + Railway | `OPENAI_API_KEY` en dos servicios | 15 min |
| `sanitizeHistory` | Sin cambio. El guard de bloques vacíos es una restricción de la API de Anthropic; en OpenAI queda inofensivo pero se deja | — |
| Todo lo anterior **× 2 repos** | GHL-NHCK y GHL-NHC-temp | ×2 |

**Total mecánico: 1-2 días.**

Lo que no está en esa tabla y es el costo real: **el prompt está afinado contra
Sonnet.** Las reglas de `prompt.js` se escribieron, se rompieron y se arreglaron
contra el comportamiento de un modelo específico. Cuánto re-tuning hace falta es
exactamente lo que responde esta evaluación — no se puede estimar antes.

### El caching no es portable

Hoy el 46% del ahorro viene de `cache_control` explícito con TTL de 1 hora, elegido
porque el tráfico es ~15 llamadas/hora por marca. OpenAI no expone control de
caché: el prefix matching es automático y el TTL no se configura. La división
`{ cached, dynamic }` de `buildSystemPrompt` sigue sirviendo (el bloque estático va
primero, así que es prefijo estricto), pero **si el caché se comporta distinto en
huecos de tráfico, el costo real de Luna y Terra sube respecto a la proyección de
la tabla de precios.** Por eso la columna `cache` de la tabla sale de tokens
reales devueltos por la API, no de una fórmula.

---

## 5. La tabla

La genera `run.js` en `eval/out/tabla.md`. Formato:

| Métrica | claude-sonnet-4-5 | luna | terra |
| --- | --- | --- | --- |
| Sigue el prompt (flow) | | | |
| Tags correctos | | | |
| Escalamiento (global) | | | |
| · escalamientos omitidos | | | |
| · escalamientos espurios | | | |
| Consistencia (N reps) | | | |
| Latencia media | | | |
| Latencia p95 | | | |
| Tokens in / out / cache | | | |
| Costo por conversación | | | |
| Costo mensual proyectado | | | |
| Calidad español | ver blind-rating.md | | |
| Cambios necesarios | ninguno (baseline) | ver §4 | ver §4 |
| **Gate crítico** | baseline | | |

`▲` mejor que el baseline con significancia · `▼` peor · `≈` dentro del ruido.

---

## 6. Por qué un umbral único de 95% es el criterio equivocado

Un 95% plano trata fallas con costos muy distintos como si fueran la misma, y se
aplica sobre el denominador equivocado.

**El denominador correcto.** La tasa de error de escalamiento se calcula solo sobre
los turnos con decisión de escalamiento, no sobre todas las conversaciones. Con
~160 conversaciones/mes que llegan a una decisión de escalamiento, un 5% de FN son
**~8 escalamientos omitidos/mes** — no 106. La cifra de 106 (5% × 2123) sale de
promediar sobre conversaciones que nunca tuvieron esa decisión, y sobreestima el
daño ~13×.

Ocho por mes sigue importando cuando algunos son autismo/TEA, pero el argumento hay
que hacerlo con el número real.

Costos por tipo de falla:

- **FN de escalamiento** (~8/mes al 95% de recall): casos clínicos atendidos por un
  flujo automático de venta. Exposición clínica y reputacional, no costo.
- **FP de escalamiento**: satura al equipo comercial con casos que la bot podía
  cerrar. Cuesta ventas, no seguridad.
- **Error de tags**: la máquina de estados se congela o registra citas fantasma en
  GHL. Un `[CITA_CONFIRMADA]` espurio es una cita que nadie agendó.
- **Error de flujo**: fricción conversacional. Molesta, se corrige con prompt.

Por eso los gates no son planos, y el de escalamiento se parte en dos:

```
tags                     ≥ 99%
flujo                    ≥ 95%
estado final             ≥ 99%
efectos externos         ≥ 99%
recall (global)          ≥ 98%   (y su cota inferior también)
precisión                ≥ 90%
```

### El gate financiero

`[CITA_CONFIRMADA]` tiene matriz y gate propios, separados de tags y de estado,
porque un falso positivo no es una métrica: genera un **link de pago de Wompi de
$100.000** y una fila en `pending_payments` (`ghl.js:236-253`).

| Esperado | Emitido | Resultado |
|---|---|---|
| Confirmar cita | Sí | TP |
| Confirmar cita | No | FN |
| **No confirmar** | **Sí** | **FP financiero** |
| No confirmar | No | TN |

El denominador es **todo turno**: un `[CITA_CONFIRMADA]` espurio puede aparecer en
cualquier punto. **Un solo FP bloquea la migración**, y el informe lo lista con su
estado de entrada, los tags que lo produjeron y los efectos simulados.

El gate cubre **tres** rutas de dinero, no una: `[CITA_CONFIRMADA]`, `[MEDIO_WOMPI]`
(un segundo link, `ghl.js:275`) y `[MEDIO_TRANSFERENCIA]`/`[MEDIO_QR]` (publican la
cuenta bancaria real). Se calcula sobre los **efectos** resueltos, no sobre un tag.

### Condiciones dependientes de datos

`[MEDIO_WOMPI]` solo cobra si además existe una fila en `pending_payments`
(`ghl.js:274`). Esa condición entra al resolver **como contexto**, no como supuesto:

| Origen | `ctx.pendingPayment` | Resultado |
|---|---|---|
| la vista reporta una fila | `true` | la rama matchea → link de Wompi |
| el `LEFT JOIN` no encontró nada | `false` | no matchea → el control cae a `[MEDIO_TRANSFERENCIA]` |
| **no se pudo consultar** | ausente | **INDETERMINADO** — el turno sale de los ejes `estado`, `ctx`, `efectos` y `financiero` |

Las dos últimas filas son distintas y no pueden colapsar: `false` es **conocimiento**
(verificamos que no hay pago pendiente), ausente es **ignorancia**. Por eso el SQL no
usa `COALESCE(has_pending, false)` — eso borraría la diferencia en el origen — y si
la vista no está disponible la consulta se reintenta sin el `JOIN`, dejando la
columna fuera.

Indeterminado **no es aprobado**: el eje queda `undefined` y el agregador lo saca del
denominador. `tags` y `flow` se siguen calificando, porque lo que el modelo emitió y
cómo lo escribió no dependen del dato faltante.

**La vista `eval_pending_flag`** expone exactamente `contact_id` + booleano. Como
corre con derechos del propietario, es una vía de acceso indirecto a la tabla base y
está acotada en cuatro sentidos: dos columnas y nada más, `REVOKE ALL FROM PUBLIC`
antes del `GRANT`, propiedad del superusuario (el rol no puede `ALTER` ni `DROP`), y
`REVOKE CREATE ON SCHEMA` para que el rol no pueda definir su propia vista ni una
función `SECURITY DEFINER` sobre `pending_payments`. `verify-readonly-db.js`
comprueba las cuatro.

Todos los efectos del harness son **simulados** (`simulated: true`, congelados). Con
el código y las dependencias actuales **no existe una ruta de cobro detectada** desde
`eval/`, y la suite bloquea las rutas conocidas — los escaneos estáticos no
demuestran imposibilidad universal. Ver [PARIDAD.md](PARIDAD.md) §Seguridad
financiera e [INVENTARIO.md](INVENTARIO.md) para el detalle por efecto.

### El gate clínico falla cerrado

No alcanza con observar 100% de recall clínico. El gate **falla automáticamente**
ante cualquiera de estas, sin importar lo que diga el porcentaje:

1. **Al menos un FN clínico.** Uno.
2. **Menos de 60 positivos clínicos etiquetados.** El mínimo sale de la tolerancia,
   no es un número mágico: por la regla de tres, cero omisiones en n solo acota la
   tasa real en 3/n, así que tolerar 5% exige n ≥ 60.
3. **La cota inferior del IC no llega al umbral**, aunque el punto sí.
4. **Errores de API en casos clínicos** que no se recuperaron con reintentos.

"No hay evidencia suficiente" es una falla, nunca un PASA. La versión anterior
mostraba `PASA` con una advertencia impresa abajo — eso invita a leer el veredicto y
saltearse la letra chica.

### Costo: el gold set no proyecta la factura

El dataset sobrepondera a propósito casos clínicos, escalamientos, triajes completos,
objeciones de precio y conversaciones largas. Su costo promedio es el de las
conversaciones más difíciles, **no el del mes**. Proyectar multiplicando ese promedio
por 2.123 sobreestima la factura.

`extract-dataset.js` mide la frecuencia real de cada estrato con `COUNT` sobre toda
la población (asignando cada conversación al **primer** estrato que matchea, porque
se solapan) y la guarda como `stratum_frequencies` en el gold set. `run.js` pondera
con eso y reporta las dos cifras por separado:

| Fila | Qué es |
|---|---|
| Costo/conv (muestra crítica) | promedio del gold set — para comparar modelos entre sí |
| Costo/conv (ponderado real) | reponderado por frecuencia de producción |
| Costo mensual proyectado | el ponderado × volumen |

**Sin `stratum_frequencies` no se proyecta nada**: la fila sale `no proyectable` en
vez de un número inventado.

Y el marco económico: el ahorro máximo es **USD 86/mes**. Una evaluación vendida son
USD 99. Un umbral que acepte perder un cliente al mes para ahorrar 86 dólares está
mal calibrado, diga lo que diga el porcentaje.

---

## 7. Construcción del gold set

**Quién etiqueta.** Dos anotadores independientes:

| Rol | Persona | Autoridad |
|---|---|---|
| Clínico | David | **Final** sobre autismo/TEA, epilepsia, y cualquier `clinical: true` |
| Técnico / flujo | Santiago | **Final** sobre tags, estados, reglas de prompt |

**Cómo se etiqueta — a ciegas del modelo.** Las expectativas se escriben mirando
**solo el mensaje del cliente**, nunca la respuesta que dio Sonnet. `extract-dataset.js`
emite el turno del cliente y deja `expect` vacío justo por esto: si el anotador ve
primero la respuesta de producción, ancla la etiqueta a lo que Sonnet hizo y se
vuelve a caer en "baseline como fuente de verdad" por la puerta de atrás.

**Solapamiento y acuerdo.** El 20% del set lo etiquetan los dos, en paralelo. Sobre
ese solapamiento se calcula **kappa de Cohen** por métrica:

- κ ≥ 0.80 → la rúbrica es clara; el resto se etiqueta single-pass
- 0.60 ≤ κ < 0.80 → se revisa la rúbrica y se re-etiqueta el solapamiento
- κ < 0.60 → la rúbrica está rota. **Se arregla la rúbrica, no las etiquetas.**

**Desacuerdos.** No se promedian ni se vota. Se resuelven por dominio: clínico →
David; técnico → Santiago. Todo desacuerdo resuelto se escribe en `expect.nota` con
el criterio aplicado, para que el mismo caso no se re-litigue después.

Un desacuerdo persistente casi siempre significa que **el prompt es ambiguo**, no
que el anotador se equivocó — y eso es un hallazgo por sí solo, independiente de qué
modelo se elija.

---

## 8. Privacidad y seguridad del proceso

**Solo lectura.** Nada en `eval/` escribe a producción:
- `extract-dataset.js` hace únicamente `SELECT`.
- Los adapters llaman a las APIs de modelo y nada más. A diferencia de
  `ai/claude.js`, **no** llaman a `db.logTokenUsage` — la evaluación no contamina la
  tabla `token_usage` ni el dashboard de facturación.
- `replay.js` nunca importa `sendMessage`, `addTag` ni `getContact`. **Ningún
  mensaje sale hacia un paciente**, en ningún modo.

**Anonimización.** `scrub()` reemplaza emails, teléfonos, cédulas y URLs antes de
que el dato salga de la base. Los `conversation_id` se reemplazan por ids opacos
(`escalado_clinico-001`), porque el id de GHL es en sí mismo un identificador que
lleva de vuelta al paciente.

⚠️ **El scrub por regex NO cubre nombres.** Aparecen como palabras comunes en texto
libre. Redactar nombres es un paso manual obligatorio durante el etiquetado, y está
en el checklist que imprime el extractor. El archivo draft **no está anonimizado**
hasta que ese paso se completa.

`eval/gold/` y `eval/out/` están en `.gitignore`. Nunca deben llegar al remoto.

---

## 9. Después de la evaluación: shadow → canary → rollout

Pasar el gate **no habilita migrar**. Habilita empezar a migrar.

**Fase 1 — Shadow (2 semanas).** El candidato corre en paralelo sobre tráfico real
y su salida se registra pero **nunca se envía**. Producción sigue en Sonnet. Se
compara turno a turno con los mismos graders. Esto atrapa lo que el gold set no
puede: distribución real de mensajes, casos que a nadie se le ocurrió etiquetar.
Requiere un flag en `callClaude` que dispare la segunda llamada en background.
Criterio de avance: ninguna divergencia clínica en dos semanas.

**Fase 2 — Canary (2 semanas).** 10% del tráfico al candidato, y **solo NHC Kids**
(Carolina) — un solo repo, un solo servicio, blast radius acotado. Se monitorea
diario: tasa de `[ESCALAR]`, tasa de `caso_complejo`, tags inventados, quejas.
Criterio de avance: métricas dentro del ruido del 90% que sigue en Sonnet.

**Fase 3 — Rollout (gradual).** 25% → 50% → 100% en Carolina; recién después Luisa.

**Fallback.** El cambio de modelo tiene que ser una **variable de entorno**, no un
deploy: `MODEL_PROVIDER=anthropic|openai` leída en `ai/claude.js`. Volver a Sonnet
debe ser cambiar una variable en Railway y reiniciar — segundos, no un revert.

**Disparadores de rollback inmediato**, sin discusión:
1. Un solo FN clínico confirmado (autismo/TEA/epilepsia no escalado)
2. Un tag filtrado a un paciente por WhatsApp
3. Tasa de `[ESCALAR]` fuera de ±30% del baseline por 24h
4. Una queja de David sobre el tono o el español

Y una advertencia sobre el punto 1: en shadow y canary el volumen es bajo, así que
**la ausencia de un FN clínico en dos semanas no prueba que no ocurra.** Con ~8
casos clínicos por semana al 10% de tráfico, se observa menos de un caso. El canary
detecta fallas groseras, no tasas bajas — por eso el gold set necesita los 60+
puntos y no se lo puede reemplazar con "lo probamos en producción un rato".
