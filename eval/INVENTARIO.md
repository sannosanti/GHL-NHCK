# Inventario de efectos externos de `webhooks/ghl.js`

Auditoría completa del archivo (899 líneas), no solo de la ruta de tags. Incluye
los efectos que `state-spec.js` **no** modela, y por qué.

## Cómo leer la columna "¿Puede ejecutarse desde eval/?"

Toda respuesta es **No**, pero con fuerzas distintas. La formulación honesta:

> Con el código y las dependencias actuales, **no existe una ruta de ejecución
> detectada** desde `eval/` hacia ninguno de estos efectos, y la suite bloquea las
> rutas conocidas. Los escaneos estáticos no demuestran imposibilidad universal.

Tres barreras, en orden de fuerza:

| Barrera | Qué garantiza |
|---|---|
| **E — Estructural** | `eval/` nunca importa ni invoca el handler del webhook. El efecto vive en una función que el harness no carga. |
| **I — Import/llamada** | Escaneo estático que bloquea `require` del módulo y la llamada a la función. Cubre rutas conocidas; no prueba imposibilidad. |
| **C — Credencial** | `preflight.js` aborta si la credencial está en el entorno. Aunque existiera una ruta, no habría con qué autenticarse. |

Los efectos con las tres son los más protegidos. Ninguno tiene menos de dos.

---

## 1. Pagos

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable desde eval? | Test |
|---|---|---|---|---|---|
| `pagos.generarLinkPago` — link Wompi $100.000 | `[CITA_CONFIRMADA]` `ghl.js:236` | **Crítico** — cobro real | `CREATE_WOMPI_PAYMENT` | No · E+I+C | `webhook-parity` nivel 2 y 3 |
| `pagos.generarLinkPago` — **segunda ruta** | `[MEDIO_WOMPI]` en `esperando_pago` **y con fila en `pending_payments`** `ghl.js:274-275` | **Crítico** — cobro real | `CREATE_WOMPI_PAYMENT`, condicionado a `ctx.pendingPayment` | No · E+I+C | 3 casos: con, sin, y sin dato |
| Publica cuenta Bancolombia real | `[MEDIO_TRANSFERENCIA]` `ghl.js:294-305` | **Alto** — datos bancarios al paciente | `SEND_BANK_DETAILS` | No · E+I+C | `MEDIO_TRANSFERENCIA publica…` |
| Publica QR y llave de pago | `[MEDIO_QR]` `ghl.js:307-318` | **Alto** | `SEND_BANK_DETAILS` | No · E+I+C | `MEDIO_QR publica…` |

> **Corrección respecto de lo que afirmé antes.** Dije que `[CITA_CONFIRMADA]` era
> *la* ruta de cobro. Son **tres**, y el gate financiero original solo cubría la
> primera. Ahora se calcula sobre los EFECTOS financieros resueltos, no sobre un tag.

## 2. `pending_payments`

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable? | Test |
|---|---|---|---|---|---|
| `db.savePendingPayment` | `[CITA_CONFIRMADA]` `ghl.js:242,249` | **Crítico** — fila que alguien deshace a mano | `INSERT_PENDING_PAYMENT` | No · E+I+C | nivel 3 |
| `db.getPendingPaymentsByContact` (lectura) | `esperando_pago` `ghl.js:272,676` | Bajo | no modelado | No · E+C | rol read-only sin `SELECT` sobre la tabla |

## 3. Mensajes al paciente

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable? | Test |
|---|---|---|---|---|---|
| `ghl.sendMessages` — texto del modelo | todas las ramas de cierre, escalamiento, POSPONER, y camino normal | **Alto** — WhatsApp real | `SEND_MESSAGE` | No · E+I+C | `no invoca efectos reales` |
| `ghl.sendMessage` — script fijo de medios de pago | `[CITA_CONFIRMADA]` `ghl.js:259` | Alto | `SEND_FIXED_MESSAGE` | No · E+I+C | ídem |
| Mensaje de reactivación | `activo nhck` `ghl.js:576` | Alto | **no modelado** (fuera de la ruta de tags) | No · E+I+C | ídem |
| Mensajes de audio no soportado | audio `ghl.js:629,639,649` | Alto | **no modelado** | No · E+I+C | ídem |
| Mensajes de comprobante recibido | imagen en `esperando_pago` `ghl.js:713,722` | Alto | **no modelado** | No · E+I+C | ídem |

## 4. Cambios de estado

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable? | Test |
|---|---|---|---|---|---|
| `db.saveConversationData` | **todas** las ramas | Medio | `SAVE_CONVERSATION` | No · E+I+C | eje `estado` |
| `db.marcarCerrado` (callback de timer) | `ghl.js:264,424` | Medio | **no modelado** (asíncrono, fuera del turno) | No · E+C | — |
| Retoma de `estado_antes_cierre` | `ghl.js:538-551` | Bajo | **no modelado** | No · E+C | — |

## 5. Recovery e inactividad

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable? | Test |
|---|---|---|---|---|---|
| `recovery_status='pospuesto'` | `[POSPONER]` `ghl.js:405` | Bajo | `SET_RECOVERY_STATUS` | No · E+C | `POSPONER conserva lo acumulado` |
| `timers.iniciarTimersInactividad` | `[CITA_CONFIRMADA]` `:263`, camino normal `:423` | Medio — dispara cierre automático | `START_INACTIVITY_TIMERS` | No · E+C | eje `efectos` |
| `timers.limpiarTimers` | `ghl.js:531,709` | Bajo | **no modelado** | No · E+C | — |
| `recovery_status=NULL` al reactivar | `ghl.js:529` | Bajo | **no modelado** | No · E+C | — |

## 6. Tags y campos en GHL

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable? | Test |
|---|---|---|---|---|---|
| `ghl.addTag` — `escalado nhck` | `[ESCALAR]` `:382` | Medio — saca la conversación del bot | `ADD_TAG` | No · E+I+C | nivel 2 |
| `ghl.addTag` — cierres | `:327,341,355` | Medio | `ADD_TAG` | No · E+I+C | nivel 2 |
| `ghl.addTag` — `validar pago nhck` | comprobante `:707,720` | Medio | **no modelado** | No · E+I+C | nivel 3 |
| `ghl.addTag` — `nhck-triaje-<p1>` | `[TRIAJE_COMPLETO]` `:185` | Bajo | `ADD_TAG` | No · E+I+C | nivel 2 |
| `ghl.actualizarEtapaOportunidad` | `:186,229,262,708` | Medio — mueve el pipeline comercial | `UPDATE_OPPORTUNITY_STAGE` | No · E+I+C | nivel 3 |
| `PUT /contacts/:id` (fetch directo) | `:151,217` | Medio — pisa nombre/email/ciudad | `UPDATE_GHL_CONTACT` | No · E+C | — |
| `guardarCiudadGHL` / `guardarSintomaGHL` | `:162,176,178` | Bajo | `SAVE_CITY`, `SAVE_SYMPTOM` | No · E+I+C | nivel 2 |
| `guardarCamposNinoGHL` / `guardarCamposPacienteGHL` | `[CITA_CONFIRMADA]` `:225,227` | Medio — datos clínicos | `SAVE_PATIENT_FIELDS` | No · E+I+C | nivel 3 |

## 7. Derivación Carolina → Luisa

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable? | Test |
|---|---|---|---|---|---|
| `db.setDerivadoA('luisa')` | `[NHC_ADULTOS]` `:371` | Medio — cambia persona y base de conocimiento | `SET_DERIVADO_A` + `ctxUpdates.derivadoA` | No · E+C | `NHC_ADULTOS deja el contexto derivado` |
| `addTag nhc-adultos` / `escalado nhck-a-nhc` | `:372,373` | Bajo | `ADD_TAG` | No · E+I+C | nivel 2 |

## 8. Agenda (Zoho)

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable? | Test |
|---|---|---|---|---|---|
| `zoho.crearTriajeInfantil` | comprobante `:689` | **Alto** — crea historia clínica | **no modelado** | No · E+I+C | nivel 3 (`services/zoho` bloqueado) |
| `zoho.crearCitasCalendario` | comprobante `:698` | **Alto** — agenda una cita real | **no modelado** | No · E+I+C | nivel 3 |
| `zoho.getDisponibilidad` (lectura) | `:117` | Bajo | **no modelado** | No · E+I+C | nivel 3 |
| `db.deleteAvailabilityCache` | `:703` | Bajo | **no modelado** | No · E+C | — |

## 9. Escrituras en base

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable? | Test |
|---|---|---|---|---|---|
| `db.logEvent` | cierres, escalamiento, cita, comprobante | Bajo | `LOG_EVENT` | No · E+C | nivel 2 |
| `DELETE FROM contact_cache` | `:156,221` | Bajo | `CLEAR_CONTACT_CACHE` | No · E+C | rol read-only |
| `db.queuePendingWebhook` | `:507,607,612` | Bajo | **no modelado** | No · E+C | rol read-only |
| `db.limpiarContactoDB` | `:74,558` | **Alto** — borra datos del contacto | **no modelado** | No · E+C | rol read-only |
| `db.setCachedDisponibilidad` | `:117` | Bajo | **no modelado** | No · E+C | rol read-only |

## 10. Llamadas externas

| Efecto | Rama | Riesgo | Simulado | ¿Ejecutable? | Test |
|---|---|---|---|---|---|
| Wompi | `[CITA_CONFIRMADA]`, `[MEDIO_WOMPI]` | **Crítico** | sí | No · E+I+C | nivel 3 |
| GHL REST | múltiples | Alto | parcial | No · E+I+C | nivel 3 |
| Zoho Creator | comprobante | Alto | no | No · E+I+C | nivel 3 |
| Whisper/Groq (transcripción) | audio `:624` | Medio — audio de paciente a un tercero | **no modelado** | No · C | `GROQ_API_KEY` bloqueada |
| Anthropic / OpenAI | — | Bajo | **es lo único que la eval SÍ llama** | Sí, por diseño | `verify-adapters.js` |
| `notifyError` | `:431` | Bajo | **no modelado** | No · E+C | — |

## 11. Logs con datos sensibles

Hallazgos de la auditoría. **No los introduce la evaluación** — son de producción, y
quedan documentados porque el inventario los pedía.

| Log | Ubicación | Qué expone |
|---|---|---|
| `console.log('WEBHOOK:', …messageBody.substring(0,30))` | `ghl.js:461` | primeros 30 caracteres del mensaje del paciente |
| `console.log('RESPUESTA OK:', {reply: …substring(0,60)})` | `ghl.js:427` | respuesta enviada al paciente |
| `console.log('AUDIO TRANSCRITO:', …substring(0,80))` | `ghl.js:624` | transcripción de audio |
| `console.log('ESTADO:', estado, '\| CONTACTO:', nombre)` | `ghl.js:752` | **nombre del paciente** |
| `console.log('CLAUDE:', JSON.stringify(data))` | `ai/claude.js:104` | **respuesta completa del modelo**, sin recortar |

Del lado de la evaluación: `run.js` escanea `eval/out/` al terminar y avisa si
encuentra emails o celulares. El gold set ya sale anonimizado, así que la salida del
modelo debería estarlo — "debería" no es una verificación, de ahí el escaneo.
`eval/out/` y `eval/gold/` están en `.gitignore`.

---

## Efectos que `state-spec.js` NO modela

Declarado explícitamente, porque el riesgo de un spec es esconder lo que omite.

**Fuera de la ruta de decisión por tags** — el harness nunca llega a estos porque
solo ejercita `resolveStateTransition()`, no el handler:

- comprobante de pago por imagen (Zoho, tags de validación, `STAGE_PAGO_PARCIAL`)
- transcripción de audio y sus escalamientos
- reactivación de contacto (`activo nhck`, `LINEA_TAG`)
- cola de webhooks pendientes, limpieza de contacto, caché de disponibilidad
- callbacks de timers (`marcarCerrado`, análisis por inactividad)
- retoma desde `estado_antes_cierre`
- `notifyError`

**Simplificaciones dentro de la ruta modelada** — declaradas en el spec:

- `SAVE_SYMPTOM` distingue adulto/niño por `derivadoA`, pero no modela el mapeo de
  categorías de cada mapper.
- `SEND_MESSAGE` modela que se envía, no el contenido; el contenido se califica en
  el eje `flow` y en el blind rating.
