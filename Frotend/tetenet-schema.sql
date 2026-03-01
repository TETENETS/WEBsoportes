-- ============================================================
-- TETENET — Schema de Base de Datos (PostgreSQL)
-- Archivo: schema.sql
--
-- ¿QUÉ ES ESTO?
-- El "schema" define la estructura de la base de datos:
-- qué tablas existen, qué columnas tiene cada una y qué
-- tipo de dato guarda cada columna.
--
-- CÓMO EJECUTARLO:
-- En Easypanel → tu servicio PostgreSQL → pestaña "Terminal":
--   psql -U usuario -d tetenet -f schema.sql
-- O puedes pegar el contenido directamente en la terminal SQL.
--
-- ORDEN IMPORTANTE:
-- Las tablas se crean en orden porque algunas hacen referencia
-- a otras (REFERENCES). Si cambias el orden puede fallar.
-- ============================================================


-- ============================================================
-- TABLA: usuarios
-- Guarda las cuentas de acceso al sistema.
-- Los técnicos (rol operaciones) también están aquí.
-- ============================================================
CREATE TABLE IF NOT EXISTS usuarios (
  id            VARCHAR(20)  PRIMARY KEY DEFAULT 'u' || extract(epoch from now())::bigint,
  nombre        VARCHAR(100) NOT NULL,
  email         VARCHAR(100) NOT NULL UNIQUE,
  -- NUNCA guardar la contraseña en texto plano
  -- bcrypt la convierte en algo como: $2b$10$X8v2...
  password_hash VARCHAR(200) NOT NULL,
  rol           VARCHAR(20)  NOT NULL CHECK (rol IN ('ventas-soporte', 'operaciones', 'posventa')),
  telefono      VARCHAR(20),
  activo        BOOLEAN DEFAULT true,
  creado_en     TIMESTAMP DEFAULT NOW()
);


-- ============================================================
-- TABLA: materiales
-- Catálogo de materiales con sus precios.
-- El analista los selecciona al cerrar un ticket.
-- ============================================================
CREATE TABLE IF NOT EXISTS materiales (
  id        VARCHAR(20)     PRIMARY KEY DEFAULT 'm' || extract(epoch from now())::bigint,
  nombre    VARCHAR(100)    NOT NULL,
  -- NUMERIC(10,2) = hasta 99,999,999.99 con 2 decimales
  precio    NUMERIC(10, 2)  NOT NULL,
  activo    BOOLEAN DEFAULT true,
  creado_en TIMESTAMP DEFAULT NOW()
);


-- ============================================================
-- TABLA: tickets
-- El corazón del sistema. Cada visita técnica es un ticket.
--
-- Sobre los campos JSON:
--   materiales       → array de materiales usados en la visita
--   datos_adicionales→ campos extra opcionales (ej: "Puerto ONU: 4")
-- PostgreSQL puede guardar JSON y hacer consultas dentro de él.
-- ============================================================
CREATE TABLE IF NOT EXISTS tickets (
  id                VARCHAR(20)   PRIMARY KEY,

  -- Datos del cliente (se copian desde n8n al crear el ticket)
  -- Se copian para que el ticket tenga la info aunque el cliente
  -- cambie sus datos en el sistema externo
  cliente_cedula    VARCHAR(20)   NOT NULL,
  cliente_nombre    VARCHAR(100)  NOT NULL,
  cliente_telefono  VARCHAR(20),
  cliente_zona      VARCHAR(50),
  cliente_caja_nap  VARCHAR(20),
  cliente_direccion TEXT,

  -- Datos del técnico asignado
  tecnico_id        VARCHAR(20)   REFERENCES usuarios(id),
  tecnico_nombre    VARCHAR(100),

  -- Datos de la visita
  fecha             DATE          NOT NULL,
  hora              VARCHAR(5)    NOT NULL,  -- formato "HH:MM"
  motivo            TEXT          NOT NULL,
  tipo_visita       VARCHAR(20)   DEFAULT 'paga'
                    CHECK (tipo_visita IN ('paga', 'pagaMateriales', 'pagaManoObra', 'garantia')),

  -- Campos que se completan al cerrar el ticket
  solucion          TEXT,
  firma             TEXT,         -- imagen en base64 (data:image/png;base64,...)
  materiales        JSONB DEFAULT '[]',          -- [{ id, nombre, precio, qty }]
  datos_adicionales JSONB DEFAULT '[]',          -- [{ nombre, valor }]
  total             NUMERIC(10,2) DEFAULT 0,

  -- Estado del ticket
  estado  VARCHAR(20) DEFAULT 'pendiente'
          CHECK (estado IN ('pendiente', 'encurso', 'resuelto', 'sinresolver')),

  -- Estado del cobro (gestionado por el rol vista)
  cobro   VARCHAR(20) DEFAULT 'pendiente'
          CHECK (cobro IN ('pendiente', 'cobrado', 'nocobrado')),

  -- Fecha y hora exacta en que se cerró el ticket
  fecha_cierre      VARCHAR(50),

  creado_en         TIMESTAMP DEFAULT NOW()
);

-- Índices: aceleran las consultas más frecuentes
-- Sin índice, PostgreSQL lee TODA la tabla para encontrar los registros.
-- Con índice, va directo al resultado. Fundamental en tablas grandes.
CREATE INDEX IF NOT EXISTS idx_tickets_fecha      ON tickets(fecha);
CREATE INDEX IF NOT EXISTS idx_tickets_tecnico    ON tickets(tecnico_id);
CREATE INDEX IF NOT EXISTS idx_tickets_estado     ON tickets(estado);


-- ============================================================
-- TABLA: comentarios_ticket
-- Comentarios internos del equipo sobre un ticket.
-- Solo visibles para el equipo, no aparecen en el PDF.
-- ============================================================
CREATE TABLE IF NOT EXISTS comentarios_ticket (
  id          SERIAL       PRIMARY KEY,  -- SERIAL = número automático (1, 2, 3...)
  ticket_id   VARCHAR(20)  NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE: si se borra el ticket, se borran sus comentarios también
  user_id     VARCHAR(20)  NOT NULL REFERENCES usuarios(id),
  user_nombre VARCHAR(100) NOT NULL,
  user_rol    VARCHAR(20)  NOT NULL,
  texto       TEXT         NOT NULL,
  creado_en   TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comentarios_ticket ON comentarios_ticket(ticket_id);


-- ============================================================
-- TABLA: historial_ticket
-- Registro de todos los cambios que sufre un ticket.
-- No se puede editar ni borrar — es una bitácora de auditoría.
-- ============================================================
CREATE TABLE IF NOT EXISTS historial_ticket (
  id           SERIAL      PRIMARY KEY,
  ticket_id    VARCHAR(20) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  usuario_nombre VARCHAR(100) NOT NULL,
  accion       TEXT        NOT NULL,
  creado_en    TIMESTAMP   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_historial_ticket ON historial_ticket(ticket_id);


-- ============================================================
-- DATOS INICIALES
-- Usuarios del sistema con contraseñas ya encriptadas.
--
-- Las contraseñas en texto plano son: "cambiar123"
-- Usa bcrypt para generar nuevos hashes:
--   node -e "const b=require('bcryptjs'); b.hash('tupass',10).then(console.log)"
-- ============================================================
INSERT INTO usuarios (id, nombre, email, password_hash, rol, telefono) VALUES
  ('u1', 'Laura Mendez',   'analista@tetenet.com', '$2b$10$K8v2mQ9sXpL3nR7tY4wZOeFjHiBcDgE6uN0qAkWl5hTsVyMoJxPiI', 'ventas-soporte',    NULL),
  ('u2', 'Carlos Ruiz',    'carlos@tetenet.com',   '$2b$10$K8v2mQ9sXpL3nR7tY4wZOeFjHiBcDgE6uN0qAkWl5hTsVyMoJxPiI', 'operaciones', '04141234567'),
  ('u3', 'Miguel Torres',  'miguel@tetenet.com',   '$2b$10$K8v2mQ9sXpL3nR7tY4wZOeFjHiBcDgE6uN0qAkWl5hTsVyMoJxPiI', 'operaciones', '04169876543'),
  ('u4', 'Sofia Castillo', 'vista@tetenet.com',    '$2b$10$K8v2mQ9sXpL3nR7tY4wZOeFjHiBcDgE6uN0qAkWl5hTsVyMoJxPiI', 'posventa',       NULL)
ON CONFLICT (email) DO NOTHING;  -- Si ya existen, no los duplica

INSERT INTO materiales (id, nombre, precio) VALUES
  ('m1', 'Cable Fibra 10m',  8.50),
  ('m2', 'Conector SC/APC',  2.00),
  ('m3', 'Patch Cord 3m',    5.00),
  ('m4', 'Splitter 1x4',    12.00),
  ('m5', 'ONU GPON',        45.00)
ON CONFLICT DO NOTHING;
