# Baseline de auditoría — `webhooks/ghl.js`

Artefacto de referencia **fuera del commit congelado `0d47ffc`**. Existe para que
el paso 1 de la auditoría (`INVENTARIO.md` contra `webhooks/ghl.js`) tenga una
línea de base reproducible, porque el inventario NO se construyó contra el
archivo que está en HEAD.

Nada de este directorio forma parte del harness ni del árbol congelado.

---

## 1. Copia exacta

`audit/ghl.js.baseline` — 899 líneas, 46.331 bytes.

Reproduce el blob declarado, verificado recalculando el hash sobre la copia:

    $ git hash-object audit/ghl.js.baseline
    3f8116fe7d7292008eb78c95fa939b2a589becfd     ← coincide con el declarado

Regenerable en cualquier momento sin este archivo:

    git cat-file -p 3f8116fe7d7292008eb78c95fa939b2a589becfd > ghl.js.baseline

---

## 2. SHA-256

El archivo existe en dos representaciones y **las dos son válidas**; hay que
saber cuál se está hasheando o los números no cuadran.

| Representación | SHA-256 |
| --- | --- |
| Normalizada LF — es la que git almacena y a la que corresponde el blob `3f8116fe`. Es `audit/ghl.js.baseline`. | `b7635304b2911fdfe6b7f4d055543a653334e2da924cf2c8e9f3e58c58eaa892` |
| Copia de trabajo CRLF — `webhooks/ghl.js` tal como está en disco | `15e0b9a3106ce757825c29048c1ad9ab486b2af50c282b7a329f92691df91750` |

### Por qué difieren

`core.autocrlf = true` en este repo. Git guarda LF y entrega CRLF al working
tree, así que los dos archivos son **byte-distintos** aunque su contenido sea
idéntico. Verificado, no asumido:

    $ diff <(tr -d '\r' < audit/ghl.js.baseline) <(tr -d '\r' < webhooks/ghl.js)
    (sin salida)

    $ tr -cd '\r' < audit/ghl.js.baseline | wc -c   →   0
    $ tr -cd '\r' < webhooks/ghl.js       | wc -c   →   899   (899 líneas, todas)

La única diferencia son los 899 CR. Numeración de líneas y contenido de cada
línea: idénticos. **Para auditar contenido, cualquiera de los dos sirve; los
números de línea de §4 valen para ambos.** Para verificar integridad por hash,
usar el par correcto de la tabla.

---

## 3. Diff contra `HEAD:webhooks/ghl.js`

`audit/ghl-baseline.diff`. HEAD es `d70be1aa` (padre del commit congelado);
`webhooks/ghl.js` no cambió entre `d70be1aa` y `0d47ffc`.

    HEAD  d48f4bc281dc4445ee122e8a950c16b20ae4ca20   →   880 líneas
    BASE  3f8116fe7d7292008eb78c95fa939b2a589becfd   →   899 líneas

**+19 líneas, −0.** Dos hunks, los dos de `LINEA_TAG`. No hay ningún otro cambio:
el baseline es HEAD más esas 19 líneas y nada más.

---

## 4. Qué líneas son de `LINEA_TAG`

Numeración del baseline (`audit/ghl.js.baseline`, y también de
`webhooks/ghl.js`: son las mismas líneas).

### Bloque 1 — declaración · líneas **29–39** (11 líneas)

| Líneas | Qué es |
| --- | --- |
| 29–37 | comentario de 9 líneas que explica por qué la línea de WhatsApp se separa de los tags de marca |
| **38** | `const LINEA_TAG = env.agentName === 'luisa' ? 'linea-nhc' : 'linea-nhck';` |
| 39 | línea en blanco |

Inerte: define una constante. Sin efecto externo.

### Bloque 2 — efecto saliente · líneas **520–527** (8 líneas)

| Líneas | Qué es |
| --- | --- |
| 520 | línea en blanco |
| 521–523 | comentario de 3 líneas: se etiqueta solo en el primer mensaje entrante |
| 524 | `if (!convData) {` |
| **525** | `ghl.addTag(contactId, LINEA_TAG).catch(() => {});` ← **única línea con efecto** |
| 526 | `}` |
| 527 | línea en blanco |

11 + 8 = 19 líneas. De las 19, **una sola produce un efecto externo**: la 525.

### Relevancia para el paso 1 de la auditoría

`ghl.addTag` es una escritura saliente hacia GHL, así que entra en el alcance del
inventario de efectos. Ya está declarada como **no modelada**:

> `INVENTARIO.md:152` — «reactivación de contacto (`activo nhck`, `LINEA_TAG`)»,
> bajo *Efectos que `state-spec.js` NO modela → Fuera de la ruta de decisión por
> tags*.

Es coherente con el diseño: la línea 525 se dispara por `!convData` (primera
conversación), no por ningún tag del modelo, así que
`resolveStateTransition()` no puede alcanzarla. El harness solo ejercita el
resolver, nunca el handler.

**Lo que la auditoría tiene que decidir** es si «declarado como no modelado»
alcanza, o si un efecto saliente hacia GHL merece estar en la tabla de efectos
con su fila propia en vez de en la lista de omisiones.

---

## 5. Confirmación: es solo baseline, no se importa ni se ejecuta

Cuatro comprobaciones, con su alcance real:

**5.1 · Ninguna referencia en el repo.** Escaneo de todo el árbol excluyendo
`audit/` y `node_modules/`, buscando `ghl.js.baseline`, `ghl-baseline` y `audit/`:
cero coincidencias.

**5.2 · El nombre no es resoluble por `require` idiomático.** El archivo se llama
`ghl.js.baseline`. `require('./ghl')` y `require('./ghl.js')` no lo alcanzan: Node
prueba `.js`, `.json` y `.node`, no `.baseline`. Haría falta escribir la ruta
completa con la extensión rara, y §5.1 muestra que nadie lo hace.

**5.3 · Está fuera del árbol del harness.** `audit/` no es `eval/`. El escáner de
`extract.test.js` (test 10g) y el escáner de efectos de `webhook-parity.test.js`
recorren `eval/`, así que este archivo no entra ni siquiera en las verificaciones
del harness — ni le hace falta.

**5.4 · No entra en el arranque de producción.** `npm start` ejecuta `server.js`.
El handler real que se carga es `webhooks/ghl.js`; `audit/ghl.js.baseline` no está
en su grafo de `require` (consecuencia de 5.1 y 5.2).

**Alcance de esta confirmación** — mismo criterio que la limitación L-2 de
`ENTREGA.md`: esto es un escaneo estático sobre el árbol actual. Demuestra que en
este repo, hoy, nada lo carga. No demuestra que sea imposible cargarlo: un
`require` con la ruta explícita funcionaría, porque Node trata las extensiones
desconocidas como JavaScript. Lo que sostiene la afirmación fuerte es que el
archivo es una **copia inerte** de código que ya está en producción — cargarlo no
agregaría capacidad que el repo no tenga.

---

## 6. Qué usa la auditoría

| Artefacto | Ubicación | Hash |
| --- | --- | --- |
| Commit congelado | git | `0d47ffc884e71a7d303eea33712547d19402c5fe` |
| `eval-harness-FROZEN.patch` | `eval/` | ver `MANIFEST-sha256.txt` |
| Baseline de `ghl.js` | `audit/ghl.js.baseline` | blob `3f8116fe` · SHA-256 `b7635304…` |
| `MANIFEST-sha256.txt` | `eval/` | — |
| `test-output.txt` | `eval/` | 362 líneas, `exit=0` |
| Documentos de entrega | `eval/` | `ENTREGA.md`, `PARIDAD.md`, `INVENTARIO.md`, `MATRIZ.md` |
