# Matriz de transiciones — producción vs evaluación

> **Archivo generado.** Sale de `eval/state-spec.js` vía `node eval/docs.js`.
> No lo edites a mano: regeneralo después de tocar el spec.

Espeja `webhooks/ghl.js:141-420`, verificado el 2026-08-05.

## La función compartida

`resolveStateTransition(estado, tags, ctx)` es **pura**: devuelve una decisión
declarativa y no ejecuta nada. Producción ejecutaría esos efectos; la evaluación
los **simula y califica**.

```
state-spec.js → resolveStateTransition()
                     ↓                    ↓
             webhooks/ghl.js        eval/replay.js
             EJECUTA efectos        SIMULA y califica
```

Ejemplo de decisión (`agendando` + `[CITA_CONFIRMADA]`):

```json
{
  "nextState": "esperando_pago",
  "continueConversation": false,
  "ctxUpdates": {},
  "effects": [
    {
      "type": "UPDATE_GHL_CONTACT",
      "fields": [
        "email",
        "city",
        "nombre"
      ]
    },
    {
      "type": "CLEAR_CONTACT_CACHE"
    },
    {
      "type": "SAVE_PATIENT_FIELDS"
    },
    {
      "type": "UPDATE_OPPORTUNITY_STAGE",
      "stage": "STAGE_LINK_PAGO"
    },
    {
      "type": "LOG_EVENT",
      "event": "cita_confirmada"
    },
    {
      "type": "CREATE_WOMPI_PAYMENT",
      "amount": 100000,
      "currency": "COP"
    },
    {
      "type": "INSERT_PENDING_PAYMENT"
    },
    {
      "type": "SEND_FIXED_MESSAGE",
      "message": "medios_de_pago"
    },
    {
      "type": "START_INACTIVITY_TIMERS"
    },
    {
      "type": "SAVE_CONVERSATION",
      "estado": "esperando_pago"
    }
  ],
  "matchedRule": "CITA_CONFIRMADA"
}
```

## Reglas

### Etapa 1 — acumulador (todas las que matcheen, en orden; gana la última)

| Tag | Estado | Ref |
| --- | --- | --- |
| `NOMBRE_PADRE` | `triaje_p1` | `ghl.js:145-158` |
| `CIUDAD_VALIDA` | _no avanza_ | `ghl.js:160-163` |
| `TRIAJE_P1` | `triaje_p2` | `ghl.js:170-180` |
| `TRIAJE_P2` | `triaje_p3` | `ghl.js:181` |
| `TRIAJE_P3` | _no avanza_ | `ghl.js:182` |
| `TRIAJE_COMPLETO` | `triaje_completo` | `ghl.js:183-187` |

### Etapa 2 — ramas de retorno temprano (gana la PRIMERA)

| # | Tag | Estado | ¿Sigue? | Ref |
| --- | --- | --- | --- | --- |
| 1 | `CITA_CONFIRMADA` | `esperando_pago` | no | `ghl.js:190-267` |
| 2 | `MEDIO_WOMPI` | `esperando_pago` | no | `ghl.js:274-292` |
| 3 | `MEDIO_TRANSFERENCIA` | `esperando_pago` | no | `ghl.js:294-305` |
| 4 | `MEDIO_QR` | `esperando_pago` | no | `ghl.js:307-318` |
| 5 | `CIUDAD_NO_DISPONIBLE` | `cerrado` | no | `ghl.js:322-333` |
| 6 | `SIN_PRESUPUESTO` | `cerrado` | no | `ghl.js:336-347` |
| 7 | `FUERA_SEGMENTO` | `cerrado` | no | `ghl.js:350-361` |
| 8 | `NHC_ADULTOS` | `triaje_p1` | sí | `ghl.js:366-378` |
| 9 | `ESCALAR` | `escalado` | no | `ghl.js:381-397` |
| 10 | `POSPONER` | _conserva acumulador_ | no | `ghl.js:400-413` |

Estados terminales: `escalado`, `cerrado`, `esperando_pago`.

Efectos financieros: `CREATE_WOMPI_PAYMENT`, `INSERT_PENDING_PAYMENT`, `SEND_BANK_DETAILS`. Un solo
falso positivo de `[CITA_CONFIRMADA]` bloquea la migración: crea un link de pago de
Wompi y una fila en `pending_payments` que alguien tiene que deshacer a mano.

---

## Matriz de casos

| Estado inicial | Tags emitidos | Estado final | ¿Sigue el replay? | Regla ganadora | Cambios de contexto | Efectos externos | ¿Riesgo financiero? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `nuevo` | `[NOMBRE_PADRE: Ana Gómez]` | `triaje_p1` | sí | _(acumulador)_ | `nombre="Ana Gómez"` | UPDATE_GHL_CONTACT<br>CLEAR_CONTACT_CACHE<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_solo avanza desde `nuevo`_ | no |
| `triaje_p1` | `[NOMBRE_PADRE: Ana]` | `triaje_p1` | sí | _(acumulador)_ | — | SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_fuera de `nuevo` no avanza_ | no |
| `triaje_p1` | `[CIUDAD_VALIDA: Medellín]` | `triaje_p1` | sí | _(acumulador)_ | — | SAVE_CITY<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_nunca mueve el estado_ | no |
| `triaje_p1` | `[TRIAJE_P1: Dificultad para concentrarse]` | `triaje_p2` | sí | _(acumulador)_ | `triaje.p1="Dificultad para concentrarse"` | SAVE_SYMPTOM<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS | no |
| `triaje_p2` | `[TRIAJE_P2: Hace 2 años]` | `triaje_p3` | sí | _(acumulador)_ | `triaje.p2="Hace 2 años"` | SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS | no |
| `triaje_p3` | `[TRIAJE_P3: Terapia de lenguaje]` | `triaje_p3` | sí | _(acumulador)_ | `triaje.p3="Terapia de lenguaje"` | SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_⚠️ solo guarda: NO avanza_ | no |
| `triaje_p3` | `[TRIAJE_P3: Nada]` + `[TRIAJE_COMPLETO]` | `triaje_completo` | sí | _(acumulador)_ | `triaje.p3="Nada"` | ADD_TAG<br>UPDATE_OPPORTUNITY_STAGE<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_la pareja que el prompt pide_ | no |
| `agendando` | `[CITA_CONFIRMADA]` | `esperando_pago` | **no** | `CITA_CONFIRMADA` | — | UPDATE_GHL_CONTACT<br>CLEAR_CONTACT_CACHE<br>SAVE_PATIENT_FIELDS<br>UPDATE_OPPORTUNITY_STAGE<br>LOG_EVENT<br>**⚠️ CREATE_WOMPI_PAYMENT**<br>**⚠️ INSERT_PENDING_PAYMENT**<br>SEND_FIXED_MESSAGE<br>START_INACTIVITY_TIMERS<br>SAVE_CONVERSATION<br>_⚠️ cobro real_ | **💰 SÍ** |
| `triaje_p1` | `[CIUDAD_NO_DISPONIBLE]` | `cerrado` | **no** | `CIUDAD_NO_DISPONIBLE` | — | ADD_TAG<br>LOG_EVENT<br>TRIGGER_ANALYSIS<br>SAVE_CONVERSATION<br>SEND_MESSAGE | no |
| `triaje_p2` | `[SIN_PRESUPUESTO]` | `cerrado` | **no** | `SIN_PRESUPUESTO` | — | ADD_TAG<br>LOG_EVENT<br>TRIGGER_ANALYSIS<br>SAVE_CONVERSATION<br>SEND_MESSAGE | no |
| `triaje_p1` | `[FUERA_SEGMENTO]` | `cerrado` | **no** | `FUERA_SEGMENTO` | — | ADD_TAG<br>LOG_EVENT<br>TRIGGER_ANALYSIS<br>SAVE_CONVERSATION<br>SEND_MESSAGE | no |
| `triaje_p1` | `[NHC_ADULTOS]` | `triaje_p1` | sí | `NHC_ADULTOS` | `derivadoA="luisa"` | SET_DERIVADO_A<br>ADD_TAG<br>ADD_TAG<br>LOG_EVENT<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>_retorna temprano pero la charla SIGUE_ | no |
| `triaje_p2` | `[ESCALAR]` | `escalado` | **no** | `ESCALAR` | — | ADD_TAG<br>LOG_EVENT<br>TRIGGER_ANALYSIS<br>SAVE_CONVERSATION<br>SEND_MESSAGE | no |
| `triaje_p2` | `[POSPONER]` | `triaje_p2` | **no** | `POSPONER` | — | SET_RECOVERY_STATUS<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>_estado intacto; escribe recovery_status_ | no |
| `triaje_p1` | _(ninguno)_ | `triaje_p1` | sí | _(acumulador)_ | — | SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_sin tags no pasa nada_ | no |
| | | | | | | |
| **RUTAS FINANCIERAS (tres, no una)** | | | | | | |
| `esperando_pago` | `[MEDIO_WOMPI]` | `esperando_pago` | **no** | `MEDIO_WOMPI` | — | **⚠️ CREATE_WOMPI_PAYMENT**<br>SEND_MESSAGE<br>SAVE_CONVERSATION<br>_⚠️ SEGUNDO link de pago (ghl.js:275)_ | **💰 SÍ** |
| `esperando_pago` | `[MEDIO_WOMPI]` | `esperando_pago` | **no** | _(acumulador)_ | — | SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_sin fila pendiente la rama no matchea y el control sigue_ | no |
| `esperando_pago` | `[MEDIO_WOMPI]` | **INDETERMINADO** | — | — | — | _sin el dato en contexto: falta `pendingPayment` — no se califica_ | no evaluable |
| `esperando_pago` | `[MEDIO_WOMPI]` + `[MEDIO_TRANSFERENCIA]` | `esperando_pago` | **no** | `MEDIO_TRANSFERENCIA` | — | **⚠️ SEND_BANK_DETAILS**<br>SAVE_CONVERSATION<br>_sin pendiente gana transferencia_ | **💰 SÍ** |
| `triaje_p2` | `[MEDIO_WOMPI]` | `triaje_p2` | sí | _(acumulador)_ | — | SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_fuera de esperando_pago no cobra ni consulta el dato_ | no |
| `esperando_pago` | `[MEDIO_TRANSFERENCIA]` | `esperando_pago` | **no** | `MEDIO_TRANSFERENCIA` | — | **⚠️ SEND_BANK_DETAILS**<br>SAVE_CONVERSATION<br>_⚠️ publica la cuenta Bancolombia real_ | **💰 SÍ** |
| `esperando_pago` | `[MEDIO_QR]` | `esperando_pago` | **no** | `MEDIO_QR` | — | **⚠️ SEND_BANK_DETAILS**<br>SAVE_CONVERSATION<br>_⚠️ publica la llave de pago_ | **💰 SÍ** |
| `esperando_pago` | `[CITA_CONFIRMADA]` + `[MEDIO_WOMPI]` | `esperando_pago` | **no** | `CITA_CONFIRMADA` | — | UPDATE_GHL_CONTACT<br>CLEAR_CONTACT_CACHE<br>SAVE_PATIENT_FIELDS<br>UPDATE_OPPORTUNITY_STAGE<br>LOG_EVENT<br>**⚠️ CREATE_WOMPI_PAYMENT**<br>**⚠️ INSERT_PENDING_PAYMENT**<br>SEND_FIXED_MESSAGE<br>START_INACTIVITY_TIMERS<br>SAVE_CONVERSATION<br>_la cita gana: un link, no dos_ | **💰 SÍ** |
| | | | | | | |
| **CASOS COMBINATORIOS OBLIGATORIOS** | | | | | | |
| `agendando` | `[CITA_CONFIRMADA]` + `[ESCALAR]` | `esperando_pago` | **no** | `CITA_CONFIRMADA` | — | UPDATE_GHL_CONTACT<br>CLEAR_CONTACT_CACHE<br>SAVE_PATIENT_FIELDS<br>UPDATE_OPPORTUNITY_STAGE<br>LOG_EVENT<br>**⚠️ CREATE_WOMPI_PAYMENT**<br>**⚠️ INSERT_PENDING_PAYMENT**<br>SEND_FIXED_MESSAGE<br>START_INACTIVITY_TIMERS<br>SAVE_CONVERSATION<br>_⚠️ la cita gana: **cobra igual**_ | **💰 SÍ** |
| `agendando` | `[CITA_CONFIRMADA]` + `[CIUDAD_NO_DISPONIBLE]` | `esperando_pago` | **no** | `CITA_CONFIRMADA` | — | UPDATE_GHL_CONTACT<br>CLEAR_CONTACT_CACHE<br>SAVE_PATIENT_FIELDS<br>UPDATE_OPPORTUNITY_STAGE<br>LOG_EVENT<br>**⚠️ CREATE_WOMPI_PAYMENT**<br>**⚠️ INSERT_PENDING_PAYMENT**<br>SEND_FIXED_MESSAGE<br>START_INACTIVITY_TIMERS<br>SAVE_CONVERSATION<br>_⚠️ cobra aunque cierre por ciudad_ | **💰 SÍ** |
| `agendando` | `[CITA_CONFIRMADA]` + `[POSPONER]` | `esperando_pago` | **no** | `CITA_CONFIRMADA` | — | UPDATE_GHL_CONTACT<br>CLEAR_CONTACT_CACHE<br>SAVE_PATIENT_FIELDS<br>UPDATE_OPPORTUNITY_STAGE<br>LOG_EVENT<br>**⚠️ CREATE_WOMPI_PAYMENT**<br>**⚠️ INSERT_PENDING_PAYMENT**<br>SEND_FIXED_MESSAGE<br>START_INACTIVITY_TIMERS<br>SAVE_CONVERSATION<br>_⚠️ cobra; POSPONER nunca se alcanza_ | **💰 SÍ** |
| `triaje_p1` | `[ESCALAR]` + `[NHC_ADULTOS]` | `triaje_p1` | sí | `NHC_ADULTOS` | `derivadoA="luisa"` | SET_DERIVADO_A<br>ADD_TAG<br>ADD_TAG<br>LOG_EVENT<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>_la derivación gana; NO escala_ | no |
| `triaje_p1` | `[ESCALAR]` + `[FUERA_SEGMENTO]` | `cerrado` | **no** | `FUERA_SEGMENTO` | — | ADD_TAG<br>LOG_EVENT<br>TRIGGER_ANALYSIS<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>_el cierre gana_ | no |
| `triaje_p1` | `[TRIAJE_P1: A]` + `[TRIAJE_P2: B]` + `[TRIAJE_P3: C]` | `triaje_p3` | sí | _(acumulador)_ | `triaje.p1="A"`<br>`triaje.p2="B"`<br>`triaje.p3="C"` | SAVE_SYMPTOM<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_varios de triaje en una salida_ | no |
| `triaje_p1` | `[TRIAJE_P1: TDAH]` + `[TRIAJE_P1: Ansiedad]` | `triaje_p2` | sí | _(acumulador)_ | `triaje.p1="TDAH"` | SAVE_SYMPTOM<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_duplicados: gana el primero (String.match)_ | no |
| `triaje_p1` | `[AGENDA_LISTA]` + `[TRIAJE_P1: TDAH]` | `triaje_p2` | sí | _(acumulador)_ | `triaje.p1="TDAH"` | SAVE_SYMPTOM<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>START_INACTIVITY_TIMERS<br>_desconocido ignorado en ruteo; `tags:invented` lo marca aparte_ | no |
| `triaje_p1` | `[CIUDAD_NO_DISPONIBLE]` + `[ESCALAR]` | `cerrado` | **no** | `CIUDAD_NO_DISPONIBLE` | — | ADD_TAG<br>LOG_EVENT<br>TRIGGER_ANALYSIS<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>_el cierre gana_ | no |
| `triaje_p1` | `[TRIAJE_P1: A]` + `[ESCALAR]` | `escalado` | **no** | `ESCALAR` | `triaje.p1="A"` | SAVE_SYMPTOM<br>ADD_TAG<br>LOG_EVENT<br>TRIGGER_ANALYSIS<br>SAVE_CONVERSATION<br>SEND_MESSAGE<br>_acumulador corre, rama sobrescribe_ | no |
| `triaje_p3` | `[TRIAJE_COMPLETO]` + `[CITA_CONFIRMADA]` | `esperando_pago` | **no** | `CITA_CONFIRMADA` | — | ADD_TAG<br>UPDATE_OPPORTUNITY_STAGE<br>UPDATE_GHL_CONTACT<br>CLEAR_CONTACT_CACHE<br>SAVE_PATIENT_FIELDS<br>UPDATE_OPPORTUNITY_STAGE<br>LOG_EVENT<br>**⚠️ CREATE_WOMPI_PAYMENT**<br>**⚠️ INSERT_PENDING_PAYMENT**<br>SEND_FIXED_MESSAGE<br>START_INACTIVITY_TIMERS<br>SAVE_CONVERSATION<br>_⚠️ rama sobre acumulador; cobra_ | **💰 SÍ** |

---

## Cinco ejes independientes

Un modelo puede emitir **los tags correctos** y aun así terminar en el estado
equivocado, porque la combinación y la precedencia deciden el desenlace.
`replay.js` compara `resolveStateTransition(estado, tagsDelModelo)` contra
`resolveStateTransition(estado, tagsDelGold)` y reporta:

| Eje | Qué falla cuando falla |
| --- | --- |
| `tags` | emitió el tag equivocado, inventó uno, u omitió el requerido |
| `estado` | los tags eran correctos pero la combinación llevó a otro estado |
| `ctx` | el payload faltó o vino mal, y los prompts siguientes se arman incompletos |
| `efectos` | disparó o se saltó una acción externa |
| `financiero` | **cobró cuando no debía, o no cobró cuando debía** — gate propio |
