# B-6 · `CAMBIAR_ESTA_CLAVE` — BLOQUEANTE DE APLICACIÓN DEL SQL

**Reclasificación.** En `ENTREGA.md` figuraba como **I-2 (importante)**. Pasa a
**B-6 (bloqueante)**: `readonly-role.PROPUESTA.sql` no puede aplicarse en ningún
entorno mientras el `CREATE ROLE` lleve una contraseña literal.

Este documento **no modifica nada**. El SQL sigue congelado en `0d47ffc` tal como
está. Acá queda registrado el hallazgo y la remediación exacta, para aplicarla en
un commit posterior a la auditoría.

---

## El problema

`eval/readonly-role.PROPUESTA.sql`, sección 3:

    CREATE ROLE nhc_eval_ro LOGIN PASSWORD 'CAMBIAR_ESTA_CLAVE'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

Por qué es bloqueante y no un recordatorio:

**Falla en abierto.** Si alguien aplica el archivo sin editarlo —que es
exactamente lo que pasa cuando se corre un `.sql` de un repo— queda un rol
`LOGIN`, con `SELECT` sobre datos clínicos de pacientes, y una contraseña que
está publicada en el repositorio. El nombre `CAMBIAR_ESTA_CLAVE` es una
instrucción para una persona, y las instrucciones para personas no son controles.

**Ya es irreversible como secreto.** La cadena está en el commit congelado
`0d47ffc` y va a seguir en la historia de git para siempre. La remediación no
puede ser «cambiarla por otra mejor en el archivo»: tiene que ser que **ninguna
cadena del archivo pueda ser nunca una contraseña real**.

**El literal invita a editarlo en el lugar equivocado.** Reemplazarlo por la
contraseña buena y correr el archivo pone el secreto en: el working tree, el
historial de shell, y el log del servidor si `log_statement` es `ddl` o `all`.

---

## Remediación propuesta — NO APLICADA

Coincide con lo que pediste: el SQL crea el rol sin contraseña y la credencial va
por un canal separado.

### 1. Crear sin cláusula `PASSWORD`

    CREATE ROLE nhc_eval_ro LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

Un rol `LOGIN` con `rolpassword` en NULL **no puede autenticarse** bajo
`scram-sha-256` ni `md5`, que es lo que usa Railway. El rol existe, tiene sus
permisos, y no entra hasta que alguien le ponga contraseña deliberadamente. Falla
en cerrado.

*Salvedad que hay que verificar en el entorno real:* bajo un `pg_hba.conf` con
`trust` o `peer`, un rol sin contraseña SÍ podría conectar. En Railway la
autenticación es por contraseña, pero es un supuesto sobre el entorno y como tal
debe comprobarse, no asumirse.

### 2. Guarda que hace fallar la transacción si quedó contraseña

Va después del `CREATE ROLE`, y convierte «nos acordamos de sacarla» en una
verificación:

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_authid
                  WHERE rolname = 'nhc_eval_ro' AND rolpassword IS NOT NULL) THEN
        RAISE EXCEPTION USING
          MESSAGE = 'nhc_eval_ro quedó creado CON contraseña.',
          DETAIL  = 'Este archivo no debe fijar credenciales: cualquier literal que '
                    'contenga queda publicado en la historia de git.',
          HINT    = 'Sacá la cláusula PASSWORD del CREATE ROLE. La credencial se '
                    'configura por el canal de la sección "Credencial".';
      END IF;
    END $$;

Requiere leer `pg_authid`, que ya exige superusuario — el mismo rol que aplica el
archivo.

### 3. La credencial, por canal separado

Fuera del repo, después de aplicar el SQL, con `\password` de psql:

    \password nhc_eval_ro

`\password` calcula el hash SCRAM **del lado del cliente** y manda el verificador,
no la cadena. La contraseña en claro no viaja, no queda en el historial de psql ni
en el log del servidor. Es la diferencia con `ALTER ROLE ... PASSWORD 'literal'`,
que sí deja el literal en el log si `log_statement` está en `ddl` o `all`.

De ahí va directo a la variable `EVAL_DATABASE_URL` del entorno de evaluación.
Nunca a un archivo del repo — `preflight.js` ya exige que la evaluación corra con
`EVAL_DATABASE_URL` y aborta si `DATABASE_URL` está siquiera presente.

### 4. Documentar el orden en el encabezado

El archivo pasa a tener dos pasos, y el segundo no es opcional:

1. aplicar el SQL → el rol existe y **no puede conectarse**;
2. `\password nhc_eval_ro` por canal separado → recién ahí puede.

---

## Qué queda pendiente de decisión

**No implementé nada de esto**, y hay una decisión que no me corresponde: si el
`CREATE ROLE` debería además llevar `VALID UNTIL` para que la credencial expire
sola. Tiene sentido para un rol de evaluación que se usa una vez, pero introduce
un modo de falla nuevo —la evaluación muere a mitad de corrida cuando vence— y esa
es una elección tuya, no una mejora obvia.

---

## Estado

| | |
| --- | --- |
| Clasificación | **B-6 · bloqueante de aplicación** (antes I-2, importante) |
| Archivo afectado | `eval/readonly-role.PROPUESTA.sql`, sección 3 |
| Estado del archivo | **congelado, sin modificar**, en `0d47ffc` |
| Estado de la remediación | **especificada, no aplicada** |
| Precondición | ninguna aplicación del SQL, en ningún entorno, hasta corregirlo |

Súmalo a los bloqueantes de `ENTREGA.md` §10: **B-1** (paridad por copia manual),
**B-2** (el SQL nunca se ejecutó), **B-3** (adapters nunca ejecutados), **B-4**
(no hay dataset), **B-5** (`(agent, conversation_id)` sigue siendo hipótesis) y
ahora **B-6**.
