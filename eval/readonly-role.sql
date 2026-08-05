-- Rol de solo lectura para la evaluación.
--
-- La convención del código (solo SELECT en extract-dataset.js, verificada por un
-- test) no es una garantía: es una promesa sobre el código actual. Este rol la
-- convierte en un permiso, de modo que un INSERT introducido por error falle en el
-- servidor y no en la revisión.
--
-- Ejecutar como superusuario UNA VEZ, contra la base de producción:
--   psql "$DATABASE_URL" -f eval/readonly-role.sql
--
-- Después, exportar SOLO esta conexión en el entorno de evaluación:
--   export EVAL_DATABASE_URL="postgres://nhc_eval_ro:<clave>@<host>:<puerto>/<base>"
--   unset DATABASE_URL
--
-- Verificar con:  node eval/verify-readonly-db.js

BEGIN;

-- 1. El rol. Cambiar la clave antes de ejecutar.
DROP ROLE IF EXISTS nhc_eval_ro;
CREATE ROLE nhc_eval_ro LOGIN PASSWORD 'CAMBIAR_ESTA_CLAVE' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

-- 2. Conectarse y ver el esquema, nada más.
GRANT CONNECT ON DATABASE current_database() TO nhc_eval_ro;
GRANT USAGE ON SCHEMA public TO nhc_eval_ro;

-- 3. SELECT sobre las tablas que la extracción necesita. Enumeradas de a una: un
--    GRANT sobre ALL TABLES incluiría cualquier tabla futura sin decisión humana.
GRANT SELECT ON conversations TO nhc_eval_ro;

-- 4. Negar explícitamente lo demás. Ya está negado por defecto; queda escrito para
--    que la intención sea legible en una auditoría.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM nhc_eval_ro;
REVOKE ALL ON SCHEMA public FROM nhc_eval_ro;
GRANT USAGE ON SCHEMA public TO nhc_eval_ro;
GRANT SELECT ON conversations TO nhc_eval_ro;

-- 5. Tablas con datos de pago y clínicos: sin acceso, ni de lectura. La evaluación
--    no las necesita, y su contenido no debería salir de producción.
REVOKE ALL ON pending_payments FROM nhc_eval_ro;
REVOKE ALL ON token_usage FROM nhc_eval_ro;

-- 6. Excepción acotada: la rama [MEDIO_WOMPI] de producción se comporta distinto
--    según exista o no una fila en pending_payments (ghl.js:274). La evaluación
--    necesita ESE BOOLEANO y nada más — sin importe, sin referencia, sin datos de
--    contacto, sin link de pago. Una vista lo expone sin abrir la tabla.
--
--    Sin esto, el resolver devuelve INDETERMINADO para esos turnos, que es correcto
--    pero deja sin calificar la segunda ruta de cobro.
--    Una vista con derechos del propietario es una vía de acceso indirecto a la
--    tabla base, así que hay que acotarla en cuatro sentidos: qué columnas expone,
--    quién la puede leer, quién la puede modificar, y que el rol no pueda crear
--    otra que sí abra la tabla.

DROP VIEW IF EXISTS eval_pending_flag;

CREATE VIEW eval_pending_flag AS
  SELECT DISTINCT contact_id, true AS has_pending
    FROM pending_payments;
--    DOS columnas y nada más: sin monto, sin referencia, sin link de pago, sin
--    payment_link_id, sin contact_data, sin fecha de cita.

-- 6.1 La vista pertenece al superusuario que corre este script. El rol de
--     evaluación no es dueño, así que no puede ALTER ni DROP ni CREATE OR REPLACE.
--     (Explícito para que la auditoría no dependa de saber quién ejecutó el
--     archivo.)
ALTER VIEW eval_pending_flag OWNER TO CURRENT_USER;

-- 6.2 Nadie más que el rol de evaluación. PUBLIC primero, porque el default de
--     algunas instalaciones deja lectura abierta.
REVOKE ALL ON eval_pending_flag FROM PUBLIC;
GRANT SELECT ON eval_pending_flag TO nhc_eval_ro;

-- 6.3 Derechos del PROPIETARIO, explícito. En PostgreSQL 15+ `security_invoker`
--     existe y su default es `false`; escribirlo evita depender del default y deja
--     la intención en el archivo. En versiones anteriores esta línea falla: si eso
--     pasa, comentala — el comportamiento por defecto ya es el correcto, pero
--     REVISÁ la versión antes de asumirlo.
ALTER VIEW eval_pending_flag SET (security_invoker = false);

-- 6.4 Que el rol no pueda crear sus propios objetos. Sin CREATE en el esquema no
--     puede definir otra vista sobre pending_payments ni una función SECURITY
--     DEFINER que la lea.
REVOKE CREATE ON SCHEMA public FROM nhc_eval_ro;

--    Comprobación esperada:
--      SET ROLE nhc_eval_ro;
--      SELECT * FROM eval_pending_flag LIMIT 1;             -- OK, 2 columnas
--      SELECT * FROM pending_payments LIMIT 1;              -- ERROR: permission denied
--      DROP VIEW eval_pending_flag;                         -- ERROR: must be owner
--      CREATE VIEW fuga AS SELECT * FROM pending_payments;  -- ERROR: permission denied

-- 6. Que las tablas nuevas NO queden legibles por defecto.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM nhc_eval_ro;

-- 7. Sin sesiones de escritura aunque alguien otorgue permisos por error.
ALTER ROLE nhc_eval_ro SET default_transaction_read_only = on;
ALTER ROLE nhc_eval_ro SET statement_timeout = '60s';

COMMIT;

-- Comprobación manual esperada (todas deben fallar):
--   SET ROLE nhc_eval_ro;
--   INSERT INTO conversations (conversation_id) VALUES ('x');   -- ERROR: read-only
--   SELECT * FROM pending_payments LIMIT 1;                     -- ERROR: permission denied
--   SELECT count(*) FROM conversations;                         -- OK
