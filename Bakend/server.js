// ============================================================
// TETENET — Backend (servidor)
// Archivo: server.js
//
// ¿QUÉ ES ESTO?
// Un "backend" es un programa que vive en el servidor y actúa
// como intermediario entre el frontend (lo que ve el usuario)
// y la base de datos (donde se guardan los datos).
//
// El frontend NUNCA habla directamente con la base de datos
// por razones de seguridad. Siempre pasa por aquí.
//
// TECNOLOGÍAS:
//   Express   → framework para crear rutas HTTP en Node.js
//   pg        → librería para hablar con PostgreSQL
//   bcrypt    → para encriptar contraseñas (nunca se guardan en texto plano)
//   jsonwebtoken → para crear tokens de sesión (JWT)
//   cors      → permite que el frontend en otro dominio haga peticiones
// ============================================================

import express    from "express";
import pg         from "pg";
import bcrypt     from "bcryptjs";
import jwt        from "jsonwebtoken";
import cors       from "cors";
import { config } from "dotenv";

// Lee las variables del archivo .env
// En Easypanel estas variables se configuran en la pestaña "Environment"
config();


// ============================================================
// BASE DE DATOS — Conexión con PostgreSQL
//
// "Pool" significa que se mantienen varias conexiones abiertas
// en lugar de abrir y cerrar una por cada petición.
// Esto es mucho más eficiente.
//
// La variable DATABASE_URL tiene este formato:
//   postgresql://usuario:contraseña@host:puerto/nombre_bd
// Easypanel te la da automáticamente cuando creas el servicio PostgreSQL.
// ============================================================
// ============================================================
// ROLES — Fuente única de verdad
// Si el nombre de un rol cambia, solo tocas este objeto.
// El resto del código lee de aquí, no tiene strings hardcodeados.
// ============================================================
const ROLES = {
  VENTAS:      "ventas-soporte",  // acceso analista / creación de tickets
  OPERACIONES: "operaciones",     // técnicos en campo
  POSVENTA:    "posventa",        // gestión de cobros y reportes
};


const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL es obligatorio en la mayoría de servicios de BD en la nube
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

// Verificar que la conexión funciona al iniciar el servidor
db.connect()
  .then(() => console.log("✅ PostgreSQL conectado"))
  .catch(err => {
    console.error("❌ Error conectando a PostgreSQL:", err.message);
    process.exit(1); // Si no hay BD, el servidor no tiene sentido
  });


// ============================================================
// N8N — Cliente para llamar a los webhooks
//
// El backend llama a n8n en dos situaciones:
//   1. Buscar datos de un cliente por cédula
//   2. Disparar notificaciones de WhatsApp
//
// n8n recibe la llamada, hace su lógica (consultar su propia BD
// de clientes, enviar WhatsApp, etc.) y devuelve la respuesta.
// ============================================================
const N8N_BASE = process.env.N8N_BASE_URL; // Ej: https://n8n.tudominio.com/webhook/tetenet

// Función helper — llama a un webhook de n8n y devuelve la respuesta
const llamarN8n = async (path, body = {}) => {
  const res = await fetch(`${N8N_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`n8n error en ${path}: ${res.status}`);
  return res.json();
};


// ============================================================
// SERVIDOR EXPRESS
//
// Express es el framework que maneja las peticiones HTTP.
// Cuando el frontend hace fetch("/tickets"), Express decide
// qué código ejecutar basado en la ruta y el método HTTP.
// ============================================================
const app = express();

// ── Middlewares ──────────────────────────────────────────────
// Los "middlewares" son funciones que se ejecutan ANTES de que
// llegue la petición a tu código. Son como filtros.

// cors: permite peticiones desde el dominio del frontend
// Sin esto el navegador bloquea las peticiones por seguridad
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
}));

// express.json(): convierte el body de la petición de texto a objeto JS
// Sin esto req.body siempre estaría vacío
app.use(express.json({ limit: "10mb" })); // 10mb para la firma en base64


// ============================================================
// AUTENTICACIÓN — Middleware JWT
//
// JWT (JSON Web Token) es un token encriptado que el servidor
// genera cuando el usuario inicia sesión. El frontend lo guarda
// y lo envía en cada petición en el header "Authorization".
//
// Estructura del token:
//   eyJhbGci... (header) . eyJ1c2VyS... (payload) . SIGNATURE
//
// El payload contiene: { userId, rol, nombre, iat, exp }
//
// "verificarToken" es un middleware que protege las rutas:
// si el token no es válido o no existe, devuelve error 401.
// ============================================================
const verificarToken = (req, res, next) => {
  // El header llega como: "Bearer eyJhbGci..."
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, mensaje: "Token requerido" });
  }

  const token = authHeader.split(" ")[1];
  try {
    // jwt.verify lanza una excepción si el token es inválido o expiró
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.usuario = payload; // Adjuntamos el usuario al request para usarlo en las rutas
    next(); // "next()" le dice a Express que continúe al siguiente paso
  } catch {
    return res.status(401).json({ ok: false, mensaje: "Token inválido o expirado" });
  }
};

// Solo el rol que se indica puede continuar
const soloRol = (...roles) => (req, res, next) => {
  if (!roles.includes(req.usuario.rol)) {
    return res.status(403).json({ ok: false, mensaje: "No tienes permiso para esta acción" });
  }
  next();
};


// ============================================================
// RUTAS — AUTH
// ============================================================

// POST /auth/login
// Recibe: { email, password }
// Devuelve: { ok, token, user }
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, mensaje: "Email y contraseña requeridos" });
  }

  try {
    // Buscamos el usuario en la base de datos
    const result = await db.query(
      "SELECT * FROM usuarios WHERE email = $1",
      [email.toLowerCase()] // $1 es un parámetro — evita SQL injection
    );

    const usuario = result.rows[0];

    // Si no existe el usuario o la contraseña no coincide
    // Usamos bcrypt.compare porque la contraseña está encriptada en la BD
    if (!usuario || !(await bcrypt.compare(password, usuario.password_hash))) {
      return res.status(401).json({ ok: false, mensaje: "Credenciales incorrectas" });
    }

    // Generamos el token JWT
    // "process.env.JWT_SECRET" es una clave secreta larga y aleatoria
    // que solo tú conoces — guárdala en las variables de entorno
    const token = jwt.sign(
      { userId: usuario.id, rol: usuario.rol, nombre: usuario.nombre },
      process.env.JWT_SECRET,
      { expiresIn: "8h" } // el token expira en 8 horas
    );

    // Nunca devolvemos el password_hash al frontend
    const { password_hash, ...userSinPassword } = usuario;

    res.json({ ok: true, token, user: userSinPassword });
  } catch (err) {
    console.error("Error en login:", err);
    res.status(500).json({ ok: false, mensaje: "Error interno del servidor" });
  }
});


// ============================================================
// RUTAS — CLIENTES
// Esta ruta delega en n8n porque los datos de clientes
// viven en el sistema externo que ya maneja n8n.
// ============================================================

// GET /clientes?cedula=V-12345678
// Llama al webhook de n8n que consulta la BD de clientes
app.get("/clientes", verificarToken, async (req, res) => {
  const { cedula } = req.query;
  if (!cedula) return res.status(400).json({ ok: false, mensaje: "Cédula requerida" });

  try {
    const data = await llamarN8n("/consultar-cliente", { cedula });
    res.json(data); // Pasa la respuesta de n8n directamente al frontend
  } catch (err) {
    console.error("Error consultando cliente en n8n:", err.message);
    res.status(500).json({ ok: false, mensaje: "No se pudo consultar el cliente" });
  }
});


// ============================================================
// RUTAS — CATÁLOGOS
// Datos que raramente cambian: técnicos y materiales.
// ============================================================

// GET /catalogos/tecnicos
app.get("/catalogos/tecnicos", verificarToken, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, nombre, telefono FROM usuarios WHERE rol = 'operaciones' ORDER BY nombre"
    );
    res.json({ ok: true, tecnicos: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: "Error obteniendo técnicos" });
  }
});

// GET /catalogos/materiales
app.get("/catalogos/materiales", verificarToken, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, nombre, precio FROM materiales WHERE activo = true ORDER BY nombre"
    );
    res.json({ ok: true, materiales: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: "Error obteniendo materiales" });
  }
});


// ============================================================
// RUTAS — TICKETS
// ============================================================

// GET /tickets
// Devuelve todos los tickets con sus comentarios e historial.
// Admite filtros opcionales por query params: ?fecha=&tecnicoId=&estado=
app.get("/tickets", verificarToken, async (req, res) => {
  const { fecha, tecnicoId, estado } = req.query;

  // Construimos la query dinámicamente según los filtros que lleguen.
  // Los arrays "conditions" y "params" crecen juntos:
  //   conditions[0] = "fecha = $1"  →  params[0] = "2026-03-01"
  const conditions = [];
  const params     = [];

  if (fecha) {
    params.push(fecha);
    conditions.push(`t.fecha = $${params.length}`);
  }
  if (tecnicoId) {
    params.push(tecnicoId);
    conditions.push(`t.tecnico_id = $${params.length}`);
  }
  if (estado) {
    params.push(estado);
    conditions.push(`t.estado = $${params.length}`);
  }

  // Si el usuario es operaciones, solo ve SUS tickets
  if (req.usuario.rol === ROLES.OPERACIONES) {
    params.push(req.usuario.userId);
    conditions.push(`t.tecnico_id = $${params.length}`);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  try {
    // Una query trae tickets + comentarios + historial en paralelo
    const [ticketsRes, comentariosRes, historialRes] = await Promise.all([
      db.query(`
        SELECT t.*, u.nombre AS tecnico_nombre
        FROM tickets t
        LEFT JOIN usuarios u ON u.id = t.tecnico_id
        ${where}
        ORDER BY t.fecha DESC, t.hora ASC
      `, params),
      db.query("SELECT * FROM comentarios_ticket ORDER BY creado_en ASC"),
      db.query("SELECT * FROM historial_ticket ORDER BY creado_en ASC"),
    ]);

    // Combinar comentarios e historial dentro de cada ticket
    const tickets = ticketsRes.rows.map(t => ({
      ...t,
      tecnicoNombre:   t.tecnico_nombre,
      comentarios:     comentariosRes.rows.filter(c => c.ticket_id === t.id),
      historial:       historialRes.rows.filter(h => h.ticket_id === t.id).map(h => ({
        ts:     h.creado_en,
        user:   h.usuario_nombre,
        accion: h.accion,
      })),
      // Convertir snake_case de la BD a camelCase para el frontend
      clienteNombre:    t.cliente_nombre,
      clienteCedula:    t.cliente_cedula,
      clienteTelefono:  t.cliente_telefono,
      clienteZona:      t.cliente_zona,
      clienteCajaNap:   t.cliente_caja_nap,
      clienteDireccion: t.cliente_direccion,
      tipoVisita:       t.tipo_visita,
      fechaCierre:      t.fecha_cierre,
      datosAdicionales: t.datos_adicionales || [],
      materiales:       t.materiales        || [],
    }));

    res.json({ ok: true, tickets });
  } catch (err) {
    console.error("Error obteniendo tickets:", err);
    res.status(500).json({ ok: false, mensaje: "Error obteniendo tickets" });
  }
});


// POST /tickets
// Crea un nuevo ticket.
// Después de crearlo, llama a n8n para que envíe el WhatsApp al técnico.
app.post("/tickets", verificarToken, soloRol(ROLES.VENTAS), async (req, res) => {
  const {
    clienteCedula, clienteNombre, clienteTelefono, clienteZona,
    clienteCajaNap, clienteDireccion, tecnicoId, tecnicoNombre,
    fecha, hora, motivo, tipoVisita, datosAdicionales,
  } = req.body;

  // Validaciones básicas — siempre valida en el backend,
  // no confíes solo en las validaciones del frontend
  if (!clienteCedula || !tecnicoId || !fecha || !hora || !motivo) {
    return res.status(400).json({ ok: false, mensaje: "Faltan campos obligatorios" });
  }

  // Verificar duplicado: mismo técnico, misma fecha, misma hora
  const dupCheck = await db.query(
    "SELECT id FROM tickets WHERE tecnico_id = $1 AND fecha = $2 AND hora = $3",
    [tecnicoId, fecha, hora]
  );
  if (dupCheck.rows.length > 0) {
    return res.status(409).json({
      ok: false,
      mensaje: `Conflicto: ${tecnicoNombre} ya tiene el ticket ${dupCheck.rows[0].id} a las ${hora} el ${fecha}`,
    });
  }

  try {
    // Generar ID único estilo TK-XXXXXX
    const id = "TK-" + Math.random().toString(36).substr(2, 6).toUpperCase();

    // INSERT INTO tickets — guardamos el ticket en la BD
    // RETURNING * devuelve la fila recién insertada
    const result = await db.query(`
      INSERT INTO tickets (
        id, cliente_cedula, cliente_nombre, cliente_telefono,
        cliente_zona, cliente_caja_nap, cliente_direccion,
        tecnico_id, tecnico_nombre, fecha, hora, motivo,
        tipo_visita, datos_adicionales, estado, cobro
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pendiente','pendiente')
      RETURNING *
    `, [
      id, clienteCedula, clienteNombre, clienteTelefono,
      clienteZona, clienteCajaNap, clienteDireccion,
      tecnicoId, tecnicoNombre, fecha, hora, motivo,
      tipoVisita, JSON.stringify(datosAdicionales || []),
    ]);

    // Guardar el primer evento en el historial
    await db.query(
      "INSERT INTO historial_ticket (ticket_id, usuario_nombre, accion) VALUES ($1, $2, $3)",
      [id, req.usuario.nombre, "Ticket creado"]
    );

    const ticket = result.rows[0];

    // Llamar a n8n para que envíe el WhatsApp al técnico
    // Lo hacemos en segundo plano con .catch() para que si n8n falla,
    // el ticket igual se crea y el error no llega al usuario
    llamarN8n("/notificar-whatsapp", {
      evento:        "ticket_creado",
      ticketId:      id,
      tecnicoNombre, tecnicoId,
      clienteNombre, hora, fecha, motivo,
      appUrl:        process.env.FRONTEND_URL,
    }).catch(err => console.error("WhatsApp no enviado:", err.message));

    res.status(201).json({ ok: true, ticket });
  } catch (err) {
    console.error("Error creando ticket:", err);
    res.status(500).json({ ok: false, mensaje: "Error creando el ticket" });
  }
});


// PATCH /tickets/:id/iniciar
// Cambia el estado a "encurso" y notifica por WhatsApp.
app.patch("/tickets/:id/iniciar", verificarToken, soloRol(ROLES.OPERACIONES), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      "UPDATE tickets SET estado = 'encurso' WHERE id = $1 AND estado = 'pendiente' RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ ok: false, mensaje: "Ticket no encontrado o ya iniciado" });
    }

    await db.query(
      "INSERT INTO historial_ticket (ticket_id, usuario_nombre, accion) VALUES ($1, $2, $3)",
      [id, req.usuario.nombre, "Soporte iniciado"]
    );

    llamarN8n("/notificar-whatsapp", {
      evento: "ticket_iniciado", ticketId: id,
    }).catch(err => console.error("WhatsApp no enviado:", err.message));

    res.json({ ok: true, estado: "encurso" });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: "Error iniciando ticket" });
  }
});


// POST /tickets/:id/cerrar
// Guarda la planilla completa y cierra el ticket.
app.post("/tickets/:id/cerrar", verificarToken, soloRol(ROLES.OPERACIONES), async (req, res) => {
  const { id } = req.params;
  const { solucion, firma, tipoVisita, materiales, total, estado, cobro } = req.body;

  if (!["resuelto", "sinresolver"].includes(estado)) {
    return res.status(400).json({ ok: false, mensaje: "Estado de cierre inválido" });
  }

  const fechaCierre = new Date().toLocaleString("es-VE");

  try {
    const result = await db.query(`
      UPDATE tickets SET
        estado = $1, solucion = $2, firma = $3, tipo_visita = $4,
        materiales = $5, total = $6, cobro = $7, fecha_cierre = $8
      WHERE id = $9 AND estado = 'encurso'
      RETURNING *
    `, [
      estado, solucion, firma, tipoVisita,
      JSON.stringify(materiales || []), total, cobro, fechaCierre, id,
    ]);

    if (result.rows.length === 0) {
      return res.status(400).json({ ok: false, mensaje: "Ticket no encontrado o no está en curso" });
    }

    await db.query(
      "INSERT INTO historial_ticket (ticket_id, usuario_nombre, accion) VALUES ($1, $2, $3)",
      [id, req.usuario.nombre, `Ticket cerrado como ${estado}`]
    );

    const ticket = result.rows[0];

    llamarN8n("/notificar-whatsapp", {
      evento: "ticket_cerrado", ticketId: id,
      estado, clienteNombre: ticket.cliente_nombre,
      tecnicoNombre: ticket.tecnico_nombre, total,
    }).catch(err => console.error("WhatsApp no enviado:", err.message));

    res.json({ ok: true, fechaCierre, estado });
  } catch (err) {
    console.error("Error cerrando ticket:", err);
    res.status(500).json({ ok: false, mensaje: "Error cerrando el ticket" });
  }
});


// PATCH /tickets/:id/cobro
// Actualiza el estado de cobro. Solo el rol "vista" puede hacer esto.
app.patch("/tickets/:id/cobro", verificarToken, soloRol(ROLES.POSVENTA), async (req, res) => {
  const { id }    = req.params;
  const { cobro } = req.body;

  if (!["pendiente", "cobrado", "nocobrado"].includes(cobro)) {
    return res.status(400).json({ ok: false, mensaje: "Estado de cobro inválido" });
  }

  try {
    await db.query("UPDATE tickets SET cobro = $1 WHERE id = $2", [cobro, id]);
    await db.query(
      "INSERT INTO historial_ticket (ticket_id, usuario_nombre, accion) VALUES ($1, $2, $3)",
      [id, req.usuario.nombre, `Estado cobro → ${cobro}`]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: "Error actualizando cobro" });
  }
});


// PUT /tickets/:id
// Modifica datos del ticket (solo analista).
app.put("/tickets/:id", verificarToken, soloRol(ROLES.VENTAS), async (req, res) => {
  const { id } = req.params;
  const { motivo, hora, fecha, tecnicoId, tecnicoNombre, tipoVisita,
          clienteNombre, clienteTelefono, clienteZona, clienteCajaNap } = req.body;

  // Verificar duplicado excluyendo el ticket actual
  const dupCheck = await db.query(
    "SELECT id FROM tickets WHERE tecnico_id = $1 AND fecha = $2 AND hora = $3 AND id != $4",
    [tecnicoId, fecha, hora, id]
  );
  if (dupCheck.rows.length > 0) {
    return res.status(409).json({ ok: false, mensaje: `Conflicto de horario con ticket ${dupCheck.rows[0].id}` });
  }

  try {
    await db.query(`
      UPDATE tickets SET
        motivo = $1, hora = $2, fecha = $3, tecnico_id = $4, tecnico_nombre = $5,
        tipo_visita = $6, cliente_nombre = $7, cliente_telefono = $8,
        cliente_zona = $9, cliente_caja_nap = $10
      WHERE id = $11
    `, [motivo, hora, fecha, tecnicoId, tecnicoNombre, tipoVisita,
        clienteNombre, clienteTelefono, clienteZona, clienteCajaNap, id]);

    await db.query(
      "INSERT INTO historial_ticket (ticket_id, usuario_nombre, accion) VALUES ($1, $2, $3)",
      [id, req.usuario.nombre, "Ticket modificado"]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: "Error modificando el ticket" });
  }
});


// DELETE /tickets/:id
// Elimina un ticket (solo analista).
app.delete("/tickets/:id", verificarToken, soloRol(ROLES.VENTAS), async (req, res) => {
  const { id } = req.params;
  try {
    // ON DELETE CASCADE en el schema borra también comentarios e historial
    await db.query("DELETE FROM tickets WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: "Error eliminando el ticket" });
  }
});


// ============================================================
// RUTAS — COMENTARIOS
// ============================================================

// POST /tickets/:id/comentarios
// Agrega un comentario interno al ticket.
app.post("/tickets/:id/comentarios", verificarToken, async (req, res) => {
  const { id }    = req.params;
  const { texto } = req.body;

  if (!texto || texto.trim().length < 3) {
    return res.status(400).json({ ok: false, mensaje: "El comentario debe tener al menos 3 caracteres" });
  }

  try {
    const result = await db.query(`
      INSERT INTO comentarios_ticket (ticket_id, user_id, user_nombre, user_rol, texto)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [id, req.usuario.userId, req.usuario.nombre, req.usuario.rol, texto.trim()]);

    const c = result.rows[0];
    // Devolvemos el comentario en el formato que espera el frontend
    res.status(201).json({
      ok: true,
      comentario: {
        id:       c.id,
        userId:   c.user_id,
        userName: c.user_nombre,
        userRol:  c.user_rol,
        ts:       c.creado_en,
        texto:    c.texto,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: "Error agregando comentario" });
  }
});


// DELETE /tickets/:id/comentarios/:comentarioId
// Elimina un comentario — solo el autor puede borrarlo.
app.delete("/tickets/:id/comentarios/:comentarioId", verificarToken, async (req, res) => {
  const { comentarioId } = req.params;

  try {
    // La condición "AND user_id = $2" garantiza que solo el autor puede borrar
    const result = await db.query(
      "DELETE FROM comentarios_ticket WHERE id = $1 AND user_id = $2 RETURNING id",
      [comentarioId, req.usuario.userId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ ok: false, mensaje: "No puedes eliminar este comentario" });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, mensaje: "Error eliminando comentario" });
  }
});


// ============================================================
// RUTA DE SALUD — Health check
//
// Easypanel (y cualquier servicio de hosting) periódicamente
// llama a una URL para saber si el servidor sigue vivo.
// Esta ruta responde rápido y confirma que todo está bien.
// ============================================================
app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1"); // Prueba que la BD responde
    res.json({ ok: true, servicio: "TETENET API", bd: "conectada" });
  } catch {
    res.status(503).json({ ok: false, bd: "desconectada" });
  }
});


// ============================================================
// INICIO DEL SERVIDOR
//
// process.env.PORT: Easypanel asigna el puerto automáticamente.
// El || 3001 es un valor por defecto para desarrollo local.
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 TETENET API corriendo en puerto ${PORT}`);
  console.log(`   Modo: ${process.env.NODE_ENV || "development"}`);
  console.log(`   n8n: ${N8N_BASE || "⚠️  N8N_BASE_URL no configurado"}`);
});
