-- PROPUESTA — NO EJECUTAR TODAVÍA.
--
-- Reescritura de readonly-role.sql. El archivo vigente sigue siendo
-- readonly-role.sql; este existe para compararlos lado a lado antes de decidir.
-- No crea nada hasta que alguien lo ejecute a propósito.
--
-- Cambios respecto del vigente:
--   1. Esquema dedicado `eval_ro`, no `public`.
--   2. Propietario explícito `nhc_eval_owner` (NOLOGIN), en vez de CURRENT_USER.
--   3. Chequeo de versión antes de `security_invoker`.
--   4. El rol de evaluación deja de ver `contact_id`.
--   5. Auditoría previa DENTRO del archivo, antes de cualquier DDL.
--   6. Desmontaje idempotente en el orden correcto.
--   7. RLS verificado, no asumido.
--
-- QUIÉN LO EJECUTA: un superusuario, o un rol con CREATEROLE + propiedad de
-- `public.conversations` y `public.pending_payments`. En Railway es el usuario
-- dueño de la base (el de DATABASE_URL). Ese rol NO queda como propietario de
-- nada de lo que se crea acá — para eso está `nhc_eval_owner`.
--
-- ===========================================================================
-- TRANSACCIONALIDAD E IDEMPOTENCIA
-- ===========================================================================
-- TRANSACCIONAL: todo va entre BEGIN y COMMIT. En PostgreSQL el DDL —incluidos
-- CREATE ROLE, DROP ROLE, GRANT y ALTER DEFAULT PRIVILEGES— es transaccional, así
-- que cualquier error deja la base exactamente como estaba. No existe un estado
-- intermedio con el rol creado y las vistas no, ni con permisos a medias.
--
-- IDEMPOTENTE: se puede correr N veces. El desmontaje (sección 1) borra en el
-- ORDEN DE DEPENDENCIA inverso al de creación:
--
--     esquema (y sus vistas)  →  privilegios del rol  →  rol
--
-- La versión anterior de esta propuesta hacía `DROP ROLE nhc_eval_owner` ANTES de
-- `DROP SCHEMA eval_ro CASCADE`. La primera aplicación funcionaba; la segunda
-- fallaba, porque el rol seguía siendo dueño del esquema y de las tres vistas y
-- PostgreSQL no deja borrar un rol con objetos. Eso está corregido acá.
--
-- LÍMITE HONESTO: los roles son objetos de CLÚSTER, no de base. `DROP OWNED BY`
-- solo alcanza los objetos y privilegios de la base ACTUAL. Si alguno de estos
-- roles tuviera objetos en otra base del mismo clúster, el DROP ROLE fallaría —
-- y la transacción entera se revierte, que es el comportamiento correcto. No es
-- un caso que este archivo pueda resolver solo.
--
-- ORDEN INTERNO: la auditoría (sección 0) es de SOLO LECTURA y corre ANTES de
-- todo el DDL. Si algún supuesto es falso, la transacción muere sin haber
-- intentado crear nada.
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 0. AUDITORÍA PREVIA — solo lectura, antes de crear o modificar NADA
-- ===========================================================================
-- Las vistas se apoyan en supuestos sobre `public.conversations`. Mientras no se
-- verifiquen, son hipótesis. Esta sección las convierte en hechos o mata la
-- transacción, y lo hace antes del primer DDL para que un fallo acá no deje
-- absolutamente nada aplicado.

-- ── 0.1 Las columnas existen y tienen el tipo que las vistas asumen ──────────
-- `messages` DEBE ser jsonb: las consultas usan `jsonb_array_length()`, que sobre
-- json (sin b) no existe. Si fuera json, las vistas se crearían igual y la
-- extracción fallaría después con 42883, ya con todo aplicado.

DO $$
DECLARE
  faltan text;
BEGIN
  SELECT string_agg(format('%s (esperado %s)', e.col, e.tipo), ', ' ORDER BY e.col)
    INTO faltan
    FROM (VALUES
      ('agent','text'), ('conversation_id','text'), ('contact_id','text'),
      ('messages','jsonb'), ('estado','text'), ('triaje','jsonb'),
      ('recovery_status','text'), ('updated_at','timestamp')
    ) AS e(col, tipo)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'conversations'
        AND c.column_name = e.col
        -- Comparación por familia: text/varchar y las variantes de timestamp son
        -- intercambiables acá; jsonb NO es intercambiable con json.
        AND CASE e.tipo
              WHEN 'text'      THEN c.data_type IN ('text','character varying','character')
              WHEN 'jsonb'     THEN c.data_type = 'jsonb'
              WHEN 'timestamp' THEN c.data_type LIKE 'timestamp%'
            END
   );

  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('public.conversations no tiene la forma esperada. Falta o difiere: %s', faltan),
      DETAIL  = 'Las vistas de evaluación seleccionan estas columnas y el extractor '
                'usa jsonb_array_length(messages), que no existe para el tipo json.',
      HINT    = 'Corregí la lista de columnas de las vistas, o el tipo de la columna.';
  END IF;
END $$;

-- ── 0.2 ¿Hay un índice REALMENTE ÚTIL para la auditoría de duplicados? ───────
--
-- La 0.3 hace un GROUP BY sobre la tabla entera. Con las ~2.100 filas actuales es
-- instantáneo; sobre una tabla grande sin índice servible es un seq scan que puede
-- pasarse del statement_timeout. Y un timeout ACÁ aborta la transacción entera sin
-- dejar nada a medias — correcto, pero deja al operador sin saber por qué.
--
-- "Existe un índice que menciona las dos columnas" NO alcanza. Un índice sirve para
-- este GROUP BY solo si cumple TODO esto, y cada condición descarta un caso real:
--
--   indisvalid    Un CREATE INDEX CONCURRENTLY que falló deja el índice inválido y
--                 presente en el catálogo. El planner no lo usa.
--   indisready    Construido pero todavía sin recibir escrituras: tampoco se usa.
--   indpred IS NULL   Un índice PARCIAL (WHERE agent = 'x') cubre un subconjunto.
--                 La auditoría necesita la tabla entera.
--   indexprs IS NULL  Un índice sobre expresiones —lower(agent)— no responde por
--                 las columnas crudas.
--   método btree  hash no soporta ordenamiento ni multicolumna; gin/gist/brin no
--                 sirven para agrupar por igualdad exacta de dos columnas.
--   PREFIJO       Las dos columnas tienen que ser las PRIMERAS del índice. Uno sobre
--                 (estado, agent, conversation_id) no evita el escaneo, porque
--                 `estado` manda en el orden.
--
-- Se reporta `pg_get_indexdef()` del que se aceptó, para que quede en el log qué
-- objeto concreto sostuvo la decisión.

DO $$
DECLARE
  filas       bigint;
  util_nombre text;
  util_def    text;
  descarte    text;
BEGIN
  SELECT reltuples::bigint INTO filas
    FROM pg_class WHERE oid = 'public.conversations'::regclass;

  -- Variables escalares, no un `record`: un SELECT INTO que no encuentra fila deja
  -- el record sin asignar, y leerle un campo después revienta con
  -- "record is not assigned yet". Con escalares, el no-match deja NULL y se puede
  -- preguntar sin sorpresas.
  SELECT i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
    INTO util_nombre, util_def
    FROM pg_index i
    JOIN pg_class  ic ON ic.oid = i.indexrelid
    JOIN pg_am     am ON am.oid = ic.relam
   WHERE i.indrelid = 'public.conversations'::regclass
     AND i.indisvalid                      -- no un CONCURRENTLY fallido
     AND i.indisready                      -- ya recibe escrituras
     AND i.indpred  IS NULL                -- no parcial
     AND i.indexprs IS NULL                -- no sobre expresiones
     AND am.amname = 'btree'
     -- Las dos columnas son las DOS PRIMERAS, en cualquier orden entre sí.
     -- `indkey` es un int2vector de subíndice CERO; se accede directo en vez de
     -- rebanar, que sobre int2vector no es portable entre versiones. Si el índice
     -- tiene una sola columna, indkey[1] da NULL y el conjunto no llega a dos.
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
            FROM pg_attribute a
           WHERE a.attrelid = i.indrelid
             AND a.attnum IN (i.indkey[0], i.indkey[1]))
         = ARRAY['agent','conversation_id']
   LIMIT 1;

  IF util_nombre IS NOT NULL THEN
    RAISE NOTICE 'Índice útil: % — %', util_nombre, util_def;
    RAISE NOTICE 'La auditoría de duplicados es barata.';
    RETURN;
  END IF;

  -- Si había índices pero ninguno sirve, decir POR QUÉ. "No hay índice" cuando en
  -- realidad hay uno parcial o inválido manda a buscar en el lugar equivocado.
  SELECT string_agg(format('%s [%s]', i.indexrelid::regclass,
           concat_ws(', ',
             CASE WHEN NOT i.indisvalid       THEN 'inválido' END,
             CASE WHEN NOT i.indisready       THEN 'no ready' END,
             CASE WHEN i.indpred  IS NOT NULL THEN 'parcial' END,
             CASE WHEN i.indexprs IS NOT NULL THEN 'por expresión' END,
             CASE WHEN am.amname <> 'btree'   THEN 'método ' || am.amname END,
             CASE WHEN (SELECT array_agg(a.attname::text ORDER BY a.attname)
                          FROM pg_attribute a
                         WHERE a.attrelid = i.indrelid
                           AND a.attnum IN (i.indkey[0], i.indkey[1]))
                       IS DISTINCT FROM ARRAY['agent','conversation_id']
                  THEN 'las dos primeras columnas no son (agent, conversation_id)' END
           )), '; ')
    INTO descarte
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_am    am ON am.oid = ic.relam
   WHERE i.indrelid = 'public.conversations'::regclass;

  -- ── El umbral es POLÍTICA PREVENTIVA, no una frontera técnica ──────────────
  --
  -- 500.000 no es el punto donde PostgreSQL deja de poder. No existe tal número:
  -- el costo real del seq scan depende del ancho de fila, del tamaño en disco, de
  -- qué haya en caché, del hardware y de la carga concurrente. Una tabla angosta de
  -- 5 millones en NVMe con todo cacheado puede tardar menos que una de 300.000 con
  -- `messages` jsonb grande y disco frío.
  --
  -- Es un umbral elegido para que, en el caso REAL de este proyecto (~2.100 filas),
  -- la auditoría corra siempre, y para que nadie aplique esto a ciegas sobre una
  -- tabla que no conoce. Combina las tres variables que sí importan y las imprime:
  -- tamaño estimado, índice servible, y statement_timeout vigente.
  --
  -- Si tu tabla es grande y sabés que el escaneo entra en el timeout, correr la
  -- consulta A2 del pie por fuera y volver es una salida perfectamente válida. El
  -- umbral no está para discutirlo, está para que la decisión sea consciente.
  IF filas > 500000 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('public.conversations tiene ~%s filas y ningún índice sirve para la auditoría.', filas),
      DETAIL  = format('Índices descartados: %s. statement_timeout vigente: %s. '
                       'El GROUP BY haría un seq scan completo dentro de esta transacción.',
                       coalesce(descarte, 'ninguno'), current_setting('statement_timeout')),
      HINT    = 'Tres salidas, todas válidas: crear un btree completo sobre '
                '(agent, conversation_id); subir statement_timeout solo para esta sesión; '
                'o correr la consulta A2 del pie de archivo por fuera y volver cuando dé 0. '
                'El umbral de 500.000 es una política preventiva de este archivo, no un '
                'límite de PostgreSQL: si conocés tu tabla, decidí con tus números.';
  END IF;

  RAISE NOTICE 'Sin índice servible (%), pero la tabla tiene ~% filas y statement_timeout es %: el escaneo es barato.',
    coalesce(descarte, 'no hay índices'), filas, current_setting('statement_timeout');
END $$;

-- ── 0.3 GUARDA DE INTEGRIDAD: la clave tiene que ser real ────────────────────
--
-- `(agent, conversation_id)` era una HIPÓTESIS: viene de que el webhook hace
-- `WHERE conversation_id=$1 AND agent=$2` (recoveryJob.js:205). Una hipótesis no
-- alcanza para construir vistas encima.
--
-- La versión anterior resolvía los empates con `ctid` — la posición física. Eso
-- ESCONDE el problema: si hay duplicados, elige uno en silencio y la muestra queda
-- dependiendo de dónde cayó la fila en el heap. Si no hay una clave estable, eso es
-- un problema de integridad, no algo que se desempata.
--
-- Sin duplicados, no hace falta desempatar nada y el DISTINCT ON sobra.

DO $$
DECLARE
  grupos  int;
  ejemplo text;
BEGIN
  SELECT count(*), min(agent || ' / ' || conversation_id)
    INTO grupos, ejemplo
    FROM (SELECT agent, conversation_id
            FROM public.conversations
           GROUP BY agent, conversation_id
          HAVING count(*) > 1) d;

  IF grupos > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('(agent, conversation_id) NO es única: %s grupo(s) duplicado(s). Ej: %s', grupos, ejemplo),
      DETAIL  = 'Las vistas de evaluación asumen una fila por (agent, conversation_id). '
                'Con duplicados habría que elegir una, y elegirla por posición física (ctid) '
                'haría que la muestra dependa del layout del heap.',
      HINT    = 'Resolvé la integridad primero, o redefiní la clave de la muestra a algo estable.';
  END IF;

  RAISE NOTICE 'Integridad verificada: (agent, conversation_id) es única.';
END $$;

-- ── 0.4 POLÍTICA DE RLS — decidida, no heredada ──────────────────────────────
--
-- QUÉ POBLACIÓN DEBE VER LA EVALUACIÓN
--   Exactamente la que ve producción: TODAS las conversaciones del `agent` que se
--   le pasa al extractor, sin filtrado por fila. Cualquier otra cosa sesga la
--   muestra: un estrato clínico recortado por una política invisible produciría un
--   recall clínico medido sobre una población que no es la real, y ese número es
--   el que decide si la migración es segura.
--
-- QUÉ VE PRODUCCIÓN HOY
--   El bot se conecta con el rol de DATABASE_URL, que es el DUEÑO de las tablas.
--   Un dueño de tabla NO está sujeto a sus propias políticas RLS salvo que la
--   tabla tenga FORCE ROW LEVEL SECURITY. Producción, por lo tanto, ve todo.
--
-- SI LAS VISTAS RESPETAN RLS
--   Sí, y por eso importa. Las vistas son `security_invoker = false` (sección 5),
--   así que las políticas de `public.conversations` se evalúan contra
--   `nhc_eval_owner`, NO contra `nhc_eval_ro` ni contra quien aplica este archivo.
--
-- PRIVILEGIOS EFECTIVOS DEL PROPIETARIO
--   `nhc_eval_owner` es NOBYPASSRLS, NOSUPERUSER, y NO es dueño de las tablas base:
--   solo tiene SELECT (sección 4). Es exactamente el perfil que SÍ queda sujeto a
--   RLS. Con RLS activo y sin una política que lo nombre, las vistas devolverían
--   CERO filas — en silencio, sin error, y el extractor produciría un dataset vacío
--   que parecería una muestra legítima.
--
-- POR QUÉ ESTE COMPORTAMIENTO COINCIDE CON PRODUCCIÓN
--   Solo coincide si RLS está apagado. Si mañana se enciende, deja de coincidir, y
--   la diferencia es silenciosa. Por eso esto es una EXCEPCIÓN y no un NOTICE: la
--   política correcta bajo RLS es una decisión de quien lo encendió, no un default
--   que este archivo pueda elegir por su cuenta.
--
--   La sección 6 vuelve a comprobarlo por resultado —comparando poblaciones— para
--   que un filtrado silencioso por CUALQUIER causa, no solo por RLS, haga fallar
--   la aplicación.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS politicas
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname IN ('conversations','pending_payments')
  LOOP
    IF t.relrowsecurity THEN
      RAISE EXCEPTION USING
        MESSAGE = format('public.%s tiene RLS activo (%s política/s, FORCE=%s).',
                         t.relname, t.politicas, t.relforcerowsecurity),
        DETAIL  = 'Las vistas corren con derechos de nhc_eval_owner, que es NOBYPASSRLS y no '
                  'es dueño de la tabla. Sin una política que lo habilite, devolverían cero '
                  'filas SIN error, y la evaluación mediría sobre una muestra vacía.',
        HINT    = 'Decidí explícitamente la política para nhc_eval_owner (por ejemplo '
                  'CREATE POLICY eval_ro_full ON public.' || t.relname ||
                  ' FOR SELECT TO nhc_eval_owner USING (true)) y volvé a correr este archivo.';
    END IF;
  END LOOP;

  RAISE NOTICE 'RLS: apagado en conversations y pending_payments. El propietario de las vistas ve la misma población que producción.';
END $$;

-- ── 0.5 EVIDENCIA sobre producción — la afirmación se verifica, no se hereda ──
--
-- La sección 0.4 dice: "producción se conecta con el dueño de las tablas, y un dueño
-- no está sujeto a sus propias políticas salvo FORCE ROW LEVEL SECURITY". Eso venía
-- afirmado sin respaldo. Este bloque imprime los hechos.
--
-- QUÉ ALCANCE TIENE ESTA VERIFICACIÓN, dicho antes de leer la salida:
--
--   SE PUEDE verificar desde acá:
--     · quién es el propietario de cada tabla;
--     · relrowsecurity y relforcerowsecurity;
--     · las políticas vigentes, con su rol, comando y expresión;
--     · qué usuarios hay CONECTADOS en este momento, por base.
--
--   NO SE PUEDE verificar desde acá:
--     · qué usuario usa cada servicio. Eso vive en la DATABASE_URL de cada servicio
--       de Railway, fuera de la base. Un servicio detenido o entre despliegues no
--       aparece en pg_stat_activity, así que la lista de conexiones es EVIDENCIA
--       PARCIAL, nunca un inventario.
--
-- Por eso esto emite NOTICE y no EXCEPTION: es material para que una persona
-- confirme, no un gate. El gate real es 0.4 —que aborta ante CUALQUIER RLS— y 6.0,
-- que compara poblaciones. Ninguno de los dos depende de que la afirmación sea
-- cierta: si producción NO se conectara como dueño, 0.4 igual habría abortado ante
-- RLS y 6.0 igual detectaría un recorte. La afirmación explica; no protege.

DO $$
DECLARE
  r record;
  n int;
BEGIN
  RAISE NOTICE '--- EVIDENCIA: propiedad de las tablas base ---';
  FOR r IN
    SELECT c.relname,
           c.relowner::regrole::text AS propietario,
           c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relname IN ('conversations','pending_payments')
     ORDER BY c.relname
  LOOP
    RAISE NOTICE '  public.% · propietario=% · relrowsecurity=% · relforcerowsecurity=%',
      r.relname, r.propietario, r.relrowsecurity, r.relforcerowsecurity;
  END LOOP;

  RAISE NOTICE '--- EVIDENCIA: políticas RLS vigentes ---';
  n := 0;
  FOR r IN
    SELECT p.polrelid::regclass::text AS tabla, p.polname,
           p.polcmd, p.polpermissive,
           coalesce((SELECT string_agg(rr::regrole::text, ', ') FROM unnest(p.polroles) rr), 'PUBLIC') AS roles,
           pg_get_expr(p.polqual,      p.polrelid) AS usando,
           pg_get_expr(p.polwithcheck, p.polrelid) AS con_chequeo
      FROM pg_policy p
     WHERE p.polrelid IN ('public.conversations'::regclass, 'public.pending_payments'::regclass)
  LOOP
    n := n + 1;
    RAISE NOTICE '  % · % · cmd=% · permisiva=% · roles=% · USING=% · WITH CHECK=%',
      r.tabla, r.polname, r.polcmd, r.polpermissive, r.roles,
      coalesce(r.usando, '—'), coalesce(r.con_chequeo, '—');
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '  (ninguna)'; END IF;

  RAISE NOTICE '--- EVIDENCIA PARCIAL: usuarios conectados ahora mismo ---';
  n := 0;
  FOR r IN
    SELECT datname, usename, coalesce(application_name,'—') AS app,
           count(*) AS conexiones, min(backend_start)::text AS mas_antigua
      FROM pg_stat_activity
     WHERE backend_type = 'client backend' AND datname IS NOT NULL
     GROUP BY 1,2,3 ORDER BY 1,2
  LOOP
    n := n + 1;
    RAISE NOTICE '  base=% · usuario=% · app=% · conexiones=% · desde=%',
      r.datname, r.usename, r.app, r.conexiones, r.mas_antigua;
  END LOOP;
  IF n = 0 THEN RAISE NOTICE '  (ninguna visible — puede faltar pg_read_all_stats)'; END IF;

  RAISE NOTICE '--- Contrastá la lista de arriba con la DATABASE_URL de CADA servicio ---';
  RAISE NOTICE '    de Railway (bot NHC, bot NHC Kids, dashboard, jobs). Un servicio';
  RAISE NOTICE '    detenido no aparece acá. Si alguno NO usa el propietario, anotalo:';
  RAISE NOTICE '    la equivalencia "eval ve lo que ve producción" habría que rehacerla';
  RAISE NOTICE '    contra ESE usuario, no contra el dueño.';
END $$;

-- ── 0.6 PRECONDICIÓN DE CLÚSTER — los roles no son de esta base ──────────────
--
-- La sección 1 hace DROP ROLE. Un rol es objeto de CLÚSTER: puede ser dueño de
-- objetos, o tener privilegios, en CUALQUIER base del servidor. `DROP OWNED BY` solo
-- alcanza la base actual, así que un rol con objetos en otra base haría fallar el
-- DROP ROLE — y ese fallo llegaría DESPUÉS de haber empezado el desmontaje.
--
-- Se verifica automáticamente, y sí se puede: `pg_shdepend` es un catálogo COMPARTIDO
-- que registra las dependencias sobre roles de todas las bases, con `dbid` indicando
-- cuál. `dbid = 0` son objetos globales (bases, tablespaces) — si el rol es dueño de
-- una base, el DROP ROLE también falla.
--
-- Se declara ANTES del primer DDL porque un fallo acá no debe encontrar nada empezado.
--
-- LÍMITE: `pg_shdepend` cubre propiedad y ACLs. No cubre el uso de un rol como
-- identidad de conexión de otra aplicación: si algún otro sistema se conecta con
-- `nhc_eval_ro`, borrarlo y recrearlo con otra contraseña lo deja afuera, y eso este
-- catálogo no lo sabe. Por eso además se listan los nombres de rol que YA existen: si
-- aparecen, no es una instalación limpia y alguien tiene que confirmar que son de
-- este archivo y de nada más.

DO $$
DECLARE
  ro    oid := to_regrole('nhc_eval_ro');      -- NULL si no existe, no explota
  owner oid := to_regrole('nhc_eval_owner');
  bases text;
  existentes text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO existentes
    FROM pg_roles WHERE rolname IN ('nhc_eval_ro','nhc_eval_owner');

  IF existentes IS NULL THEN
    RAISE NOTICE 'Instalación limpia: ni nhc_eval_ro ni nhc_eval_owner existen todavía.';
    RETURN;
  END IF;

  RAISE NOTICE 'Roles preexistentes: %. Se van a borrar y recrear.', existentes;
  RAISE NOTICE 'Confirmá que NINGÚN otro sistema se conecta con ellos: recrearlos cambia la contraseña.';

  SELECT string_agg(DISTINCT coalesce(d.datname, '<objeto global del clúster>'), ', ')
    INTO bases
    FROM pg_shdepend s
    LEFT JOIN pg_database d ON d.oid = s.dbid
   WHERE s.refclassid = 'pg_authid'::regclass
     AND s.refobjid IN (ro, owner)
     AND s.dbid IS DISTINCT FROM (SELECT oid FROM pg_database WHERE datname = current_database());

  IF bases IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('nhc_eval_ro/nhc_eval_owner tienen objetos o privilegios fuera de esta base: %s', bases),
      DETAIL  = 'DROP OWNED BY solo alcanza la base actual, así que el DROP ROLE de la '
                'sección 1 fallaría. La transacción se revertiría entera, pero es mejor '
                'saberlo antes de empezar.',
      HINT    = 'Conectate a cada una de esas bases y corré DROP OWNED BY para los dos '
                'roles, o REASSIGN OWNED si esos objetos deben conservarse. Después volvé acá.';
  END IF;

  RAISE NOTICE 'Precondición de clúster: los roles no tienen dependencias fuera de %.', current_database();
END $$;

-- ===========================================================================
-- 1. DESMONTAJE IDEMPOTENTE — en orden de dependencia inverso
-- ===========================================================================
-- Primero el esquema con sus vistas, después los privilegios que los roles tengan
-- sobre objetos ajenos, y recién al final los roles. Al revés, PostgreSQL rechaza
-- el DROP ROLE porque el rol todavía es dueño de algo.

DROP SCHEMA IF EXISTS eval_ro CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nhc_eval_ro') THEN
    -- Quita GRANTs sobre objetos de otros y entradas en ALTER DEFAULT PRIVILEGES.
    EXECUTE 'DROP OWNED BY nhc_eval_ro';
    EXECUTE 'DROP ROLE nhc_eval_ro';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nhc_eval_owner') THEN
    EXECUTE 'DROP OWNED BY nhc_eval_owner';
    EXECUTE 'DROP ROLE nhc_eval_owner';
  END IF;
END $$;

-- ===========================================================================
-- 2. Rol propietario, sin login
-- ===========================================================================
-- Existe solo para ser dueño del esquema y de las vistas, y para sostener el único
-- GRANT sobre pending_payments que la vista necesita. Nadie se conecta como él:
-- NOLOGIN lo hace inalcanzable incluso con la contraseña correcta.

CREATE ROLE nhc_eval_owner
  NOLOGIN          -- inalcanzable aunque alguien tenga una contraseña
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE     -- no puede fabricarse roles con más permisos
  NOINHERIT        -- no absorbe privilegios de roles que lo contengan
  NOREPLICATION
  NOBYPASSRLS;     -- si mañana se activa RLS, la respeta (ver 0.4)

-- Sin membresías administrativas: no pertenece a pg_read_all_data, pg_write_all_data,
-- pg_monitor ni a ningún rol de la aplicación. Se afirma acá para que la auditoría
-- no dependa de revisar pg_auth_members a mano.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT roleid::regrole AS padre FROM pg_auth_members WHERE member = 'nhc_eval_owner'::regrole
  LOOP
    RAISE EXCEPTION 'nhc_eval_owner hereda de % — no debería pertenecer a ningún rol', r.padre;
  END LOOP;
END $$;

-- ===========================================================================
-- 3. Rol de evaluación
-- ===========================================================================
CREATE ROLE nhc_eval_ro LOGIN PASSWORD 'CAMBIAR_ESTA_CLAVE'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

ALTER ROLE nhc_eval_ro SET default_transaction_read_only = on;
ALTER ROLE nhc_eval_ro SET statement_timeout = '60s';
ALTER ROLE nhc_eval_ro SET search_path = eval_ro;   -- no ve `public` por defecto

-- ===========================================================================
-- 4. Esquema dedicado y permiso mínimo del propietario
-- ===========================================================================
-- Fuera de `public`: lo que se cree en `public` mañana no queda automáticamente
-- al alcance, y la superficie del rol es enumerable de un vistazo.

CREATE SCHEMA eval_ro AUTHORIZATION nhc_eval_owner;

REVOKE ALL ON SCHEMA eval_ro FROM PUBLIC;
GRANT USAGE ON SCHEMA eval_ro TO nhc_eval_ro;   -- USAGE, nunca CREATE

-- El rol de evaluación NO necesita `public` en absoluto bajo este diseño.
REVOKE ALL ON SCHEMA public FROM nhc_eval_ro;

-- La vista corre con derechos del propietario, así que `nhc_eval_owner` necesita
-- leer las dos tablas base. Nada más: sin INSERT, sin UPDATE, sin otras tablas.
GRANT USAGE ON SCHEMA public TO nhc_eval_owner;
GRANT SELECT ON public.conversations   TO nhc_eval_owner;
GRANT SELECT ON public.pending_payments TO nhc_eval_owner;

-- ===========================================================================
-- 5. UNA definición base, dos vistas derivadas
-- ===========================================================================
-- Arquitectura elegida: DOS VISTAS SEGURAS, no vista única obligatoria.
--
-- La alternativa —una sola vista, y si falla la extracción aborta— acopla la
-- medición clínica al dato financiero: un problema en `pending_payments` (RLS
-- activado, un rename, un permiso revocado) bloquearía TODA la evaluación,
-- incluido el gate clínico, que es el que decide si la migración es segura y no
-- tiene nada que ver con pagos.
--
-- Las dos derivan de UNA base, así que la población y las columnas comunes son
-- idénticas POR CONSTRUCCIÓN, no por disciplina de mantener dos SELECT en sincronía.
--
--   conversation_base          ← población + columnas comunes + contact_id
--        │                       (INTERNA: no se le otorga al rol de evaluación)
--        ├── conversation_sample_basic   = base menos contact_id
--        └── conversation_sample         = basic + has_pending
--
-- Sin DISTINCT ON: la sección 0.3 ya garantizó que la clave es única.
--
-- SIN IDENTIFICADOR, ni siquiera hasheado.
--
-- Una versión anterior exponía `sha256(conversation_id)`. Un hash simple de un
-- identificador de bajo cardinal SIGUE SIENDO ENLAZABLE: quien tenga la tabla puede
-- hashear los 2123 conversation_id y construir la correspondencia en un segundo.
-- No es anonimización, es ofuscación.
--
-- Alternativa si la trazabilidad llega a ser un requisito real: HMAC con un secreto
-- que el proceso de evaluación NO tenga. Requiere pgcrypto y un lugar donde viva el
-- secreto. Hoy no hace falta: el extractor asigna ids opacos por posición.

CREATE VIEW eval_ro.conversation_base AS
  SELECT
    c.agent,
    c.conversation_id,
    c.contact_id,
    c.messages,
    c.estado,
    c.triaje,
    c.recovery_status,
    c.updated_at
  FROM public.conversations c;

ALTER VIEW eval_ro.conversation_base OWNER TO nhc_eval_owner;
REVOKE ALL ON eval_ro.conversation_base FROM PUBLIC;
-- SIN GRANT al rol de evaluación: expone contact_id y conversation_id. Existe solo
-- para que las dos vistas públicas compartan una definición.

-- ── 5a. Respaldo: población y columnas comunes, sin nada financiero ──────────
-- No menciona `pending_payments`. Por eso sigue funcionando cuando la principal no.
-- Al faltar `has_pending`, `pendingPaymentFrom()` devuelve `undefined` y el resolver
-- marca esos turnos INDETERMINADOS — nunca `false`, que significaría "verificamos
-- que no hay pago pendiente".

CREATE VIEW eval_ro.conversation_sample_basic AS
  SELECT b.agent, b.messages, b.estado, b.triaje, b.recovery_status, b.updated_at
    FROM eval_ro.conversation_base b;

ALTER VIEW eval_ro.conversation_sample_basic OWNER TO nhc_eval_owner;
REVOKE ALL ON eval_ro.conversation_sample_basic FROM PUBLIC;
GRANT SELECT ON eval_ro.conversation_sample_basic TO nhc_eval_ro;

-- ── 5b. Principal: lo mismo, más el booleano financiero ──────────────────────
-- EXISTS, no JOIN: un LEFT JOIN contra pending_payments multiplica la fila una vez
-- por pago pendiente del contacto, y una conversación con tres pagos aparecería
-- tres veces en la muestra. EXISTS corta en la primera coincidencia.

CREATE VIEW eval_ro.conversation_sample AS
  SELECT b.agent, b.messages, b.estado, b.triaje, b.recovery_status, b.updated_at,
         EXISTS (
           SELECT 1 FROM public.pending_payments pp
            WHERE pp.contact_id = b.contact_id
         ) AS has_pending
    FROM eval_ro.conversation_base b;

ALTER VIEW eval_ro.conversation_sample OWNER TO nhc_eval_owner;
REVOKE ALL ON eval_ro.conversation_sample FROM PUBLIC;
GRANT SELECT ON eval_ro.conversation_sample TO nhc_eval_ro;
-- Sin WITH GRANT OPTION: el rol no puede reotorgar el acceso a nadie.

-- ===========================================================================
-- 6. VERIFICACIÓN POR RESULTADO — al aplicar, no en el README
-- ===========================================================================
-- Que las dos vistas deriven de la misma base hace la paridad cierta POR
-- CONSTRUCCIÓN. Esto la comprueba igual, porque "por construcción" deja de valer en
-- cuanto alguien edite una de las dos, y porque hay causas de divergencia que no
-- están en el texto del CREATE VIEW: RLS, un GRANT faltante, un tipo distinto.

-- ── 6.0 La población es la de producción, no una recortada ───────────────────
-- Esta es la comprobación que atrapa el filtrado SILENCIOSO. Si RLS, un permiso o
-- cualquier otra cosa recortara lo que ve `nhc_eval_owner`, la vista devolvería
-- menos filas que la tabla base sin lanzar ningún error. El bloque 0.4 previene la
-- causa conocida; éste detecta el efecto, venga de donde venga.

-- El conteo NO se compara contra `SELECT count(*) FROM public.conversations` a secas.
-- Eso da por sentado que la vista base no filtra nada, y esa igualdad es una
-- propiedad de la definición ACTUAL, no una invariante: en cuanto alguien agregue un
-- WHERE a `conversation_base` —excluir un agente de prueba, acotar por fecha, lo que
-- sea— el chequeo empezaría a fallar sin que nada esté roto, y el reflejo sería
-- relajarlo hasta que deje de servir.
--
-- Así que el filtro funcional se DECLARA una vez, en `FILTRO_BASE`, y de ahí salen
-- las dos cosas: el conteo de referencia contra la tabla fuente, y la comprobación de
-- que la vista realmente no aplica ningún otro. Si mañana la vista filtra, hay que
-- actualizar la constante — y el bloque lo exige en vez de dejarlo pasar.

DO $$
DECLARE
  -- ÚNICA fuente de verdad del filtro funcional de eval_ro.conversation_base.
  -- Hoy la vista es un SELECT sin WHERE, así que el predicado es `true`.
  FILTRO_BASE constant text := 'true';
  definicion text;
  n_fuente bigint; n_vista bigint;
BEGIN
  -- 1. La declaración tiene que coincidir con la vista REAL. Con FILTRO_BASE='true',
  --    la vista no puede tener WHERE: si lo tiene, la constante quedó desactualizada
  --    y el conteo de referencia sería el de otra población.
  definicion := pg_get_viewdef('eval_ro.conversation_base'::regclass, true);
  IF FILTRO_BASE = 'true' AND upper(definicion) LIKE '%WHERE%' THEN
    RAISE EXCEPTION USING
      MESSAGE = 'eval_ro.conversation_base tiene un WHERE, pero FILTRO_BASE dice `true`.',
      DETAIL  = format('Definición actual: %s', definicion),
      HINT    = 'Actualizá la constante FILTRO_BASE de este bloque con el mismo predicado '
                'que la vista, para que el conteo de referencia compare poblaciones '
                'equivalentes y no tabla-entera contra vista-filtrada.';
  END IF;

  -- 2. Referencia construida CON el mismo filtro, contra la tabla fuente.
  EXECUTE format('SELECT count(*) FROM public.conversations c WHERE %s', FILTRO_BASE)
    INTO n_fuente;

  -- 3. La vista se evalúa con derechos de nhc_eval_owner aunque la consulte otro:
  --    este count() SÍ ejerce el contexto de privilegios real.
  SELECT count(*) INTO n_vista FROM eval_ro.conversation_base;

  IF n_fuente <> n_vista THEN
    RAISE EXCEPTION USING
      MESSAGE = format('La vista base ve %s filas; la consulta fuente con el mismo filtro (%s) devuelve %s.',
                       n_vista, FILTRO_BASE, n_fuente),
      DETAIL  = 'A igual filtro, la población difiere: nhc_eval_owner está viendo un '
                'recorte. La evaluación mediría sobre una muestra sesgada y el resultado '
                'parecería legítimo.',
      HINT    = 'Revisá RLS (pg_policy), los GRANT de la sección 4, y si la tabla tiene '
                'FORCE ROW LEVEL SECURITY.';
  END IF;

  RAISE NOTICE 'Población: % filas, igual a public.conversations WHERE %.', n_vista, FILTRO_BASE;
END $$;

-- ── 6.0b El dato financiero también se ve, no solo las filas ─────────────────
-- El chequeo anterior compara CANTIDAD DE FILAS, y `has_pending` no la cambia: es
-- una columna, no un JOIN. Si `nhc_eval_owner` no pudiera ver `pending_payments`
-- —RLS sobre esa tabla, una política que no lo nombra— el EXISTS devolvería `false`
-- en todas las filas SIN error, el conteo seguiría cuadrando, y el dataset diría
-- `pending_payment_disponible: true` con todos los valores en `false`.
--
-- Ése es el peor resultado del sistema entero: el gate financiero NO se bloquearía
-- —porque la fuente principal respondió— y mediría contra una realidad inventada
-- donde nadie tiene pagos pendientes.

DO $$
DECLARE
  n_vista bigint; n_directo bigint;
BEGIN
  SELECT count(*) INTO n_vista FROM eval_ro.conversation_sample WHERE has_pending;

  -- Mismo predicado, evaluado con los privilegios de quien aplica (que sí llega a
  -- las dos tablas). Si difiere, el propietario de la vista ve otra cosa.
  SELECT count(*) INTO n_directo
    FROM public.conversations c
   WHERE EXISTS (SELECT 1 FROM public.pending_payments pp WHERE pp.contact_id = c.contact_id);

  IF n_vista <> n_directo THEN
    RAISE EXCEPTION USING
      MESSAGE = format('has_pending es true en %s filas de la vista, pero %s conversaciones tienen pago pendiente.',
                       n_vista, n_directo),
      DETAIL  = 'nhc_eval_owner no ve pending_payments igual que quien aplica este archivo. '
                'La vista respondería sin error con datos financieros falsos, y el gate '
                'financiero NO se bloquearía: emitiría veredicto sobre datos inventados.',
      HINT    = 'Revisá RLS sobre public.pending_payments y el GRANT SELECT de la sección 4.';
  END IF;

  IF n_directo = 0 THEN
    RAISE WARNING 'Ninguna conversación tiene pago pendiente. Es consistente entre vista y '
                  'tabla, así que no hay fuga de permisos, pero el gate financiero no va a '
                  'tener casos positivos que medir. Confirmá que es lo esperado.';
  END IF;

  RAISE NOTICE 'Dato financiero: % filas con has_pending, coincide con la consulta directa.', n_vista;
END $$;

-- ── 6.1 Las columnas comunes existen en las dos y tienen el MISMO tipo ───────
-- Un tipo distinto entre vistas no cambia el count() ni el EXCEPT ALL de texto,
-- pero sí cambia lo que llega al extractor: jsonb y json se serializan distinto en
-- `pg`, y `messages` alimenta jsonb_array_length().

DO $$
DECLARE
  discrepancia text;
  n_comunes    int;
BEGIN
  WITH comunes(col) AS (
    VALUES ('agent'),('messages'),('estado'),('triaje'),('recovery_status'),('updated_at')
  ),
  cols AS (
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'eval_ro'
       AND table_name IN ('conversation_sample','conversation_sample_basic')
  )
  SELECT string_agg(format('%s: sample=%s basic=%s',
                           c.col,
                           coalesce(a.data_type,'AUSENTE'),
                           coalesce(b.data_type,'AUSENTE')), ', ' ORDER BY c.col)
    INTO discrepancia
    FROM comunes c
    LEFT JOIN cols a ON a.table_name = 'conversation_sample'       AND a.column_name = c.col
    LEFT JOIN cols b ON b.table_name = 'conversation_sample_basic' AND b.column_name = c.col
   -- `IS NULL` además de `IS DISTINCT FROM`: si una columna común faltara en LAS DOS
   -- vistas, los dos data_type serían NULL y `IS DISTINCT FROM` no la marcaría.
   WHERE a.data_type IS DISTINCT FROM b.data_type OR a.data_type IS NULL;

  IF discrepancia IS NOT NULL THEN
    RAISE EXCEPTION 'Las columnas comunes no coinciden entre las dos vistas: %', discrepancia;
  END IF;

  -- Y la principal aporta `has_pending` boolean, ni más ni menos.
  SELECT count(*) INTO n_comunes
    FROM information_schema.columns
   WHERE table_schema = 'eval_ro' AND table_name = 'conversation_sample'
     AND column_name = 'has_pending' AND data_type = 'boolean';
  IF n_comunes <> 1 THEN
    RAISE EXCEPTION 'conversation_sample debe exponer has_pending boolean (encontradas: %)', n_comunes;
  END IF;

  RAISE NOTICE 'Columnas comunes: mismos nombres y mismos tipos en las dos vistas.';
END $$;

-- ── 6.2 Mismo total y MISMO MULTICONJUNTO, en las dos direcciones ────────────
-- `EXCEPT ALL` es asimétrico: A EXCEPT ALL B vacío NO implica B EXCEPT ALL A vacío.
-- Con solo una dirección, una vista con filas de más pasaría el chequeo. Van las dos.

DO $$
DECLARE
  n_basic bigint; n_sample bigint;
  sobran_basic bigint; sobran_sample bigint;
BEGIN
  SELECT count(*) INTO n_basic  FROM eval_ro.conversation_sample_basic;
  SELECT count(*) INTO n_sample FROM eval_ro.conversation_sample;
  IF n_basic <> n_sample THEN
    RAISE EXCEPTION 'Las vistas no comparten población: basic=%, sample=%', n_basic, n_sample;
  END IF;

  SELECT count(*) INTO sobran_basic FROM (
    SELECT agent, messages, estado, triaje, recovery_status, updated_at FROM eval_ro.conversation_sample_basic
    EXCEPT ALL
    SELECT agent, messages, estado, triaje, recovery_status, updated_at FROM eval_ro.conversation_sample
  ) d;

  SELECT count(*) INTO sobran_sample FROM (
    SELECT agent, messages, estado, triaje, recovery_status, updated_at FROM eval_ro.conversation_sample
    EXCEPT ALL
    SELECT agent, messages, estado, triaje, recovery_status, updated_at FROM eval_ro.conversation_sample_basic
  ) d;

  IF sobran_basic > 0 OR sobran_sample > 0 THEN
    RAISE EXCEPTION USING MESSAGE = format(
      'Las columnas comunes difieren: % fila(s) solo en basic, % fila(s) solo en sample.',
      sobran_basic, sobran_sample);
  END IF;

  RAISE NOTICE 'Multiconjunto idéntico en ambas direcciones: % filas.', n_basic;
END $$;

-- ── 6.3 Misma distribución por agent y por estado ────────────────────────────
-- El EXCEPT ALL de 6.2 ya lo implica. Se comprueba igual porque es lo que sostiene
-- la ESTRATIFICACIÓN: si el fallback cambiara la mezcla de estados, los estratos
-- clínicos se llenarían distinto y las dos corridas no serían comparables. Además
-- este mensaje dice DÓNDE está la diferencia, cosa que un conteo global no hace.

DO $$
DECLARE
  d text;
BEGIN
  WITH a AS (
    SELECT agent, estado, count(*) AS n FROM eval_ro.conversation_sample_basic GROUP BY 1,2
  ), b AS (
    SELECT agent, estado, count(*) AS n FROM eval_ro.conversation_sample       GROUP BY 1,2
  )
  SELECT string_agg(format('(%s, %s): basic=%s sample=%s',
                           coalesce(a.agent, b.agent),
                           coalesce(a.estado, b.estado, '<null>'),
                           coalesce(a.n, 0), coalesce(b.n, 0)), '; ')
    INTO d
    FROM a FULL OUTER JOIN b
      ON a.agent = b.agent AND a.estado IS NOT DISTINCT FROM b.estado
   WHERE coalesce(a.n, 0) <> coalesce(b.n, 0);

  IF d IS NOT NULL THEN
    RAISE EXCEPTION 'La distribución por (agent, estado) difiere entre las vistas: %', d;
  END IF;

  RAISE NOTICE 'Distribución por (agent, estado): idéntica.';
END $$;

-- ===========================================================================
-- 7. security_invoker, con chequeo de versión
-- ===========================================================================
-- La opción existe desde PostgreSQL 15. En versiones anteriores el default ya es
-- el correcto (derechos del propietario), pero asumirlo sin verificar la versión
-- es exactamente el tipo de suposición que esta revisión existe para eliminar.
--
-- Importa para 0.4: con security_invoker=false, las políticas RLS de las tablas
-- base se evalúan contra nhc_eval_owner. Con true se evaluarían contra nhc_eval_ro,
-- que no tiene NINGÚN privilegio sobre public — y las vistas fallarían siempre.

DO $$
DECLARE v int := current_setting('server_version_num')::int;
BEGIN
  IF v >= 150000 THEN
    EXECUTE 'ALTER VIEW eval_ro.conversation_base          SET (security_invoker = false)';
    EXECUTE 'ALTER VIEW eval_ro.conversation_sample_basic  SET (security_invoker = false)';
    EXECUTE 'ALTER VIEW eval_ro.conversation_sample        SET (security_invoker = false)';
    RAISE NOTICE 'PostgreSQL % — security_invoker=false fijado explícitamente en las tres vistas.', current_setting('server_version');
  ELSE
    RAISE NOTICE 'PostgreSQL % — security_invoker no existe en esta versión; el default (derechos del propietario) es el comportamiento esperado. VERIFICADO, no asumido.', current_setting('server_version');
  END IF;
END $$;

-- ===========================================================================
-- 8. Nada nuevo queda legible por defecto
-- ===========================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public  REVOKE ALL ON TABLES FROM nhc_eval_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA eval_ro REVOKE ALL ON TABLES FROM nhc_eval_ro;

COMMIT;

-- ---------------------------------------------------------------------------
-- Comprobación esperada
-- ---------------------------------------------------------------------------
--   SET ROLE nhc_eval_ro;
--
--   SELECT * FROM eval_ro.conversation_sample LIMIT 1;       -- OK, sin contact_id
--   SELECT * FROM eval_ro.conversation_sample_basic LIMIT 1; -- OK, sin has_pending
--   SELECT * FROM eval_ro.conversation_base LIMIT 1;         -- ERROR: permission denied
--   SELECT * FROM public.conversations LIMIT 1;              -- ERROR: permission denied
--   SELECT * FROM public.pending_payments LIMIT 1;           -- ERROR: permission denied
--   DROP VIEW eval_ro.conversation_sample;                   -- ERROR: must be owner
--   CREATE VIEW eval_ro.fuga AS SELECT 1;                    -- ERROR: permission denied
--   SET ROLE nhc_eval_owner;                                 -- ERROR: NOLOGIN / no es miembro
--
-- ---------------------------------------------------------------------------
-- Verificación de permisos efectivos (correr como superusuario tras aplicar)
-- ---------------------------------------------------------------------------
--   -- Todo lo que el rol de evaluación puede tocar. Deben ser DOS filas, ambas
--   -- SELECT: conversation_sample y conversation_sample_basic. `conversation_base`
--   -- NO debe aparecer.
--   SELECT table_schema, table_name, privilege_type
--     FROM information_schema.table_privileges
--    WHERE grantee = 'nhc_eval_ro';
--
--   -- Sin GRANT OPTION en ninguna:
--   SELECT table_name, is_grantable FROM information_schema.table_privileges
--    WHERE grantee = 'nhc_eval_ro' AND is_grantable = 'YES';   -- 0 filas
--
--   -- Sin membresías:
--   SELECT roleid::regrole FROM pg_auth_members
--    WHERE member IN ('nhc_eval_ro'::regrole, 'nhc_eval_owner'::regrole);  -- 0 filas
--
--   -- Atributos de rol:
--   SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole
--     FROM pg_roles WHERE rolname LIKE 'nhc_eval%';
--   -- owner: canlogin=f, super=f, bypassrls=f, inherit=f, createrole=f
--   -- ro:    canlogin=t, super=f, bypassrls=f, inherit=f, createrole=f
--
--   -- RLS, que la sección 0.4 exige apagado:
--   SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
--    WHERE relname IN ('conversations','pending_payments');
--
-- ---------------------------------------------------------------------------
-- LO QUE HAY QUE CAMBIAR EN EL CÓDIGO SI SE ADOPTA
-- ---------------------------------------------------------------------------
--   · `fetchRows` y `fetchFrequencies` consultan las vistas de `eval_ro` en vez de
--     `public.conversations`, y ya no hacen el LEFT JOIN.
--   · La vista no expone identificador: el extractor asigna una clave posicional
--     (`${estrato}#${índice}`) antes de llamar a buildDataset. La deduplicación
--     entre consultas ya es estructuralmente imposible por la exclusión mutua.
--   · `has_pending` es boolean siempre, nunca NULL.
--
-- ---------------------------------------------------------------------------
-- Pérdida del `undefined` por fila — las cuatro condiciones
-- ---------------------------------------------------------------------------
-- Aceptar que `has_pending` no pueda ser "desconocido" a nivel de fila exige que
-- las cuatro se cumplan. Estado de cada una bajo esta propuesta:
--
--   1. La consulta a la vista es ATÓMICA.
--      ✔ Un solo SELECT: o devuelve todas las filas o falla entera. No hay un
--        estado intermedio donde algunas filas tengan el dato y otras no.
--
--   2. `true`/`false` representa CONOCIMIENTO real.
--      ✔ Con EXISTS, `false` significa "no hay ninguna fila en pending_payments
--        para este contacto", que es una afirmación verificada, no un default.
--
--   3. La indisponibilidad COMPLETA deja `pending_payment_disponible = false`.
--      ✔ `extractWithFallback()` intenta la extracción REAL contra cada fuente
--        dentro de un SAVEPOINT, y `sourceMetadata()` DERIVA el metadato de la
--        fuente que efectivamente completó. Si ninguna completa, lanza
--        EnvironmentError y no hay dataset.
--        Cubierto por los tests 8h-8q y 9a-9j de extract.test.js.
--
--   4. Eso BLOQUEA el gate financiero.
--      ✔ `pendingPaymentDisponible !== true` produce estado BLOQUEADO, distinto de
--        NO PASA y de PASA.
--
-- ---------------------------------------------------------------------------
-- Tres resultados distintos, con salidas distintas
-- ---------------------------------------------------------------------------
--   ERROR DE ENTORNO   ninguna vista completó → la extracción aborta, exit 2.
--                      No hay dataset. Se arreglan las vistas.
--   GATE BLOQUEADO     se usó el respaldo → la evaluación corre, el gate financiero
--                      no puede emitir veredicto. Se arregla la vista y se recorre.
--   MODELO NO PASA     se midió y no cumple. Re-correr no cambia nada.
