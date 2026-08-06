# Migración de calendarios Zoho → GHL

Herramientas de un solo uso, escritas para reparar el ruteo histórico de citas y
bloqueos hacia los calendarios de cada terapeuta en GHL. Se conservan porque el
problema puede repetirse: si el mapa `CALENDARIOS` de `webhooks/zoho.js` cambia,
o si un consultor nuevo entra sin calendario asignado, sus entradas van a
acumularse en el calendario General y habrá que volver a repartirlas.

## El problema que resolvieron

El webhook de Zoho Creator envía solo cuatro campos: `Contacto`, `Inicio`, `Fin`
y `Duraci_n`. No manda `Consultor`. Sin ese dato, `CALENDARIOS[...]` nunca
resolvía y el `|| CALENDAR_GENERAL` se tragaba el 100% de las entradas en
silencio.

La solución en producción fue leer el registro de vuelta desde `Citas_Report`,
que sí expone `Consultor`, `Tipo` y `Observaciones`
(`buscarCitaPorInicio` en `services/zoho.js`). Estos scripts aplican esa misma
resolución sobre lo que ya estaba mal ruteado.

El calendario de Juan Esteban Tamayo se llamaba "Pre-evaluación NHC" hasta el
2026-08-06. Se renombró porque el cliente lo buscaba por el nombre del
profesional y no lo encontraba. "Neuromapeo NHC" y "Neurotecnologías" siguen
nombrados por el servicio, y está bien: en Zoho son recursos, no personas.

Resultado de la corrida de agosto 2026: **197 citas** y **271 bloqueos** movidos
de General a su terapeuta.

## Cómo se ejecutan

Necesitan `GHL_API_KEY`, `GHL_LOCATION_ID`, `ZOHO_CLIENT_ID`,
`ZOHO_CLIENT_SECRET` y `ZOHO_REFRESH_TOKEN`. La forma de correrlos sin tocar un
`.env` es inyectar el entorno de producción con la CLI de Railway:

```bash
railway run -p <projectId> -s <serviceId> -e <environmentId> -- node scripts/calendario/plan-citas.js
```

En PowerShell 5.1 usar `;` para encadenar, no `&&`.

## El orden importa

Siempre: **planificar → revisar → migrar → verificar**. Nunca migrar sin haber
leído el plan.

| Paso | Citas | Bloqueos |
| --- | --- | --- |
| 1. Planificar (solo lectura) | `plan-citas.js` | `plan-bloqueos.js` |
| 2. Migrar | `migrar-citas.js` | `migrar-bloqueos.js` |
| 3. Verificar | `verificar-citas.js` | `verificar-bloqueos.js` |
| Deshacer | `revertir-citas.js` | — |

Los pasos 1 y 3 no modifican nada.

### 1. Planificar

Escribe `plan.json` / `plan-bloqueos.json` con un movimiento por entrada:
evento, destino, terapeuta y el ID del registro Zoho que lo justifica. Lo que no
se pudo resolver queda listado aparte, con el motivo. **Nada se modifica.**

Revisar el conteo por terapeuta antes de seguir. Si algo no cuadra ahí, no va a
cuadrar después.

### 2. Migrar

Ejecuta exactamente lo que dice el plan — no recalcula sobre la marcha, así que
lo que se aplica es lo que se revisó.

Son seguros de re-ejecutar. Cada entrada se vuelve a leer antes de tocarla: si ya
está en destino se saltea, y si está en un calendario que no es General se deja
en paz en lugar de pisarla. El progreso se escribe línea por línea en
`resultados.ndjson` / `resultados-bloqueos.ndjson`, de modo que un corte a mitad
no pierde nada y la corrida siguiente retoma sola.

Ante 5 fallos seguidos abortan, en vez de insistir cientos de veces contra un
error sistemático. **Los fallos sueltos se reintentan volviendo a correr el mismo
script.**

### 3. Verificar

Cuenta eventos por calendario en el rango. Sirve para confirmar que General
quedó solo con lo que no tenía match.

### Deshacer

`revertir-citas.js` devuelve a General todo lo que figure como movido en
`resultados.ndjson`. Lee el log de lo ejecutado, no el plan — solo toca lo que
realmente se movió.

No hay equivalente para bloqueos: se puede reconstruir a partir de
`resultados-bloqueos.ndjson`, que guarda `desde`, `startTime` y `endTime` de cada
uno.

## Cosas que cuestan caro aprender de nuevo

**Los bloqueos viven en otro endpoint.** `GET /calendars/events` devuelve
únicamente citas. Los bloqueos solo aparecen en `GET /calendars/blocked-slots`,
que exige `calendarId`, `userId` o `groupId` (responde 422 sin ninguno). Para
moverlos: `PUT /calendars/events/block-slots/{id}` — es `events/block-slots`, no
`blocked-slots`.

**`toNotify: false` es obligatorio.** Sin eso, mover una cita puede notificar al
paciente. Verificado en una cita real antes de la migración masiva: con el flag
en `false` no salió ningún mensaje. Son cientos de personas; no es un detalle.

**El PUT reemplaza, no parchea.** Hay que reenviar `startTime`, `endTime`,
`title` y `appointmentStatus` sin cambios o se borran.

**Los títulos no toleran saltos de línea.** GHL responde
`422 Title must be a valid text`. Las `Observaciones` de Zoho son texto libre con
invitaciones de Google Meet pegadas enteras. Por eso todo título pasa por
`tituloGHL` (`webhooks/zoho.js`), que aplana los espacios y corta a 100
caracteres.

**`/calendars/events` corta en 200 por respuesta.** Los scripts recorren en
tramos semanales y deduplican por id; sin eso el conteo miente hacia abajo.

**GHL devuelve 503 y 401 esporádicos** bajo carga sostenida, incluso con 350 ms
entre llamadas. En la primera corrida fallaron 3 de 197 por esto y nada más. Es
la razón de que el reintento sea por ítem y no global.

**Zoho ignora `max_records`** en `Citas_Report`: 5, 50, 200 u omitirlo devuelven
lo mismo. El techo real es el page size de Creator y nadie maneja la paginación
por `record_cursor`. El día más cargado observado son 72 registros, así que es un
límite latente, no un bug vivo.

## Archivos generados

`plan*.json` y `resultados*.ndjson` quedan fuera de git: son de una corrida
puntual y contienen nombres de pacientes.
