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

## Por qué `LOGIN` sin contraseña NO alcanza

Una versión anterior de este documento proponía crear el rol como `LOGIN` sin
cláusula `PASSWORD`, con el argumento de que un `rolpassword` en NULL no
autentica. **Ese argumento es incompleto y no debe usarse como control.**

`rolpassword` en NULL solo bloquea la conexión bajo métodos que verifican
contraseña: `scram-sha-256`, `md5`, `password`. `pg_hba.conf` admite otros que la
ignoran por completo:

| Método | Qué pasa con `rolpassword` NULL |
| --- | --- |
| `scram-sha-256`, `md5`, `password` | conexión rechazada — es el caso que se asumía |
| `trust` | **conecta sin credencial** |
| `peer` (local) | conecta si el usuario del SO coincide con el nombre del rol |
| `ident` | conecta según el mapeo ident |
| `cert` | conecta con certificado de cliente; la contraseña no participa |
| `gss`, `sspi`, `ldap`, `pam`, `radius` | la autenticación es externa; `rolpassword` no interviene |

Basta una regla de esas —presente hoy, o agregada después por otro motivo— para
que el rol quede alcanzable. El control quedaría dependiendo de una configuración
que este archivo no controla, no puede leer de forma confiable desde SQL, y que
puede cambiar sin que nadie recuerde este rol.

**Por eso la remediación no crea el rol como `LOGIN`.**

---

## Remediación propuesta — NO APLICADA

Cuatro pasos, en orden. El rol es inalcanzable durante los tres primeros, sin
importar qué diga `pg_hba.conf`.

### Paso 1 · Crear el rol `NOLOGIN`

    CREATE ROLE nhc_eval_ro NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

`NOLOGIN` es un atributo del rol, no una regla de autenticación. PostgreSQL
rechaza la conexión **antes** de consultar `pg_hba.conf`: no hay método —ni
`trust`, ni `cert`, ni `peer`— que permita conectarse a un rol `NOLOGIN`. Es la
única forma de que el bloqueo no dependa del entorno.

Es además el mismo atributo que ya lleva `nhc_eval_owner`, por la misma razón.

### Paso 2 · Permisos y validación del entorno, con el rol todavía cerrado

Todo lo que hoy hacen las secciones 4 a 8 del SQL: esquema, `GRANT`, vistas,
verificación de población, paridad, `security_invoker`, privilegios por defecto.

Si algo de eso falla, la transacción se revierte y **nunca existió un rol capaz de
conectarse**. Es la diferencia importante con el orden actual: hoy el rol se crea
con credencial en la sección 3, mucho antes de que se valide nada.

Al cierre, una guarda que verifica que sigue cerrado y sin credencial:

    DO $$
    DECLARE r record;
    BEGIN
      SELECT rolcanlogin, rolpassword IS NOT NULL AS tiene_pass, rolvaliduntil
        INTO r FROM pg_authid WHERE rolname = 'nhc_eval_ro';

      IF r.rolcanlogin OR r.tiene_pass THEN
        RAISE EXCEPTION USING
          MESSAGE = format('nhc_eval_ro quedó con LOGIN=%s y contraseña=%s.',
                           r.rolcanlogin, r.tiene_pass),
          DETAIL  = 'Este archivo debe dejar el rol inalcanzable. Habilitar LOGIN y fijar '
                    'la credencial son pasos manuales posteriores, deliberados y '
                    'registrados. Un literal en este archivo queda publicado en git.',
          HINT    = 'Revisá el CREATE ROLE de la sección 3: NOLOGIN y sin cláusula PASSWORD.';
      END IF;
    END $$;

Leer `pg_authid` exige superusuario, que es el mismo rol que aplica el archivo.

### Paso 3 · Credencial por canal separado

Fuera del repo, con el rol todavía `NOLOGIN`:

    \password nhc_eval_ro

`\password` calcula el verificador SCRAM **del lado del cliente** y envía el hash,
no la cadena. La contraseña en claro no viaja, no queda en el historial de psql ni
en el log del servidor. Es la diferencia con `ALTER ROLE … PASSWORD 'literal'`,
que sí deja el literal en el log si `log_statement` está en `ddl` o `all`.

De ahí va directo a `EVAL_DATABASE_URL` del entorno de evaluación. Nunca a un
archivo del repo — `preflight.js` ya exige esa variable y aborta si `DATABASE_URL`
está siquiera presente.

Con el rol `NOLOGIN`, tener la contraseña todavía no sirve para conectarse. El
secreto puede establecerse, rotarse o descartarse sin abrir nada.

### Paso 4 · Habilitar `LOGIN`, después de verificar `pg_hba.conf`

Último paso, deliberado y separado:

    ALTER ROLE nhc_eval_ro LOGIN;

**Precondición: leer `pg_hba.conf` y confirmar** que la única regla que aplica a
este rol, base y origen exige contraseña (`scram-sha-256`), y que ninguna regla
más permisiva la precede — el orden importa, gana la primera coincidencia.

    SHOW hba_file;                                  -- dónde está
    SELECT * FROM pg_hba_file_rules;                -- PostgreSQL 10+, ya parseado

`pg_hba_file_rules` es la forma correcta de mirarlo: devuelve las reglas ya
interpretadas, en orden, con su `error` si alguna está mal escrita. Requiere
superusuario.

Este paso es **manual y fuera del archivo SQL** a propósito. Automatizarlo dentro
de la transacción convertiría la verificación de `pg_hba.conf` en un chequeo que
alguien va a terminar salteando; separado, es una decisión con nombre y momento.

---

## Qué cambia respecto del estado congelado

| | Congelado en `0d47ffc` | Remediación propuesta |
| --- | --- | --- |
| Creación | `LOGIN PASSWORD 'CAMBIAR_ESTA_CLAVE'` | `NOLOGIN`, sin `PASSWORD` |
| Alcanzable al terminar el SQL | **sí**, con credencial pública | no, y sin depender de `pg_hba.conf` |
| Credencial | literal en el repo | `\password`, canal separado |
| `LOGIN` | desde el `CREATE ROLE` | `ALTER ROLE` manual, tras verificar `pg_hba.conf` |
| Si el SQL falla a mitad | el rol nunca llega a crearse (transacción) | igual, y además nunca sería alcanzable |

---

## Decisión operativa pendiente — `VALID UNTIL`

**No es requisito inicial.** Queda registrada como decisión operativa, para
tomarse cuando se defina la ventana de uso del rol.

A favor: un rol de evaluación se usa en una ventana acotada, y una credencial que
expira sola no depende de que alguien se acuerde de revocarla.

En contra: introduce un modo de falla nuevo. Si vence a mitad de una corrida de
24.000 llamadas, la extracción muere con un error de autenticación que no se
parece a ninguno de los que el harness clasifica — `classifySourceError` lo vería
como `environment` y abortaría, correctamente, pero después de haber gastado.

Es una elección de operación, no una mejora obvia, y depende de cuánto dure la
ventana de evaluación. No se implementa junto con los cuatro pasos de arriba.

---

## Nota sobre la revisión de esta remediación

La primera versión de este documento proponía `CREATE ROLE … LOGIN` sin
contraseña, apoyándose en que `rolpassword` NULL no autentica. Eso es cierto solo
bajo métodos que verifican contraseña, y dejaba el control colgando de
`pg_hba.conf`. La secuencia `NOLOGIN` → permisos → credencial → `LOGIN` no tiene
esa dependencia: el rol es inalcanzable por atributo hasta el último paso.

---

## Estado

| | |
| --- | --- |
| Clasificación | **B-6 · bloqueante de aplicación** (antes I-2, importante) |
| Archivo afectado | `eval/readonly-role.PROPUESTA.sql`, sección 3 |
| Estado del archivo | **congelado, sin modificar**, en `0d47ffc` |
| Estado de la remediación | **especificada, no aplicada** — 4 pasos |
| `VALID UNTIL` | decisión operativa pendiente, **no** requisito inicial |
| Precondición | ninguna aplicación del SQL, en ningún entorno, hasta corregirlo |

Súmalo a los bloqueantes de `ENTREGA.md` §10: **B-1** (paridad por copia manual),
**B-2** (el SQL nunca se ejecutó), **B-3** (adapters nunca ejecutados), **B-4**
(no hay dataset), **B-5** (`(agent, conversation_id)` sigue siendo hipótesis) y
ahora **B-6**.
