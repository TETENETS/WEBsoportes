// Archivo: cambiar-clave.js
import bcrypt from "bcryptjs";
import pg from "pg";
import { config } from "dotenv";

config();

const { Pool } = pg;
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function actualizarContraseñas() {
  // 👇 ESCRIBE AQUÍ LA CONTRASEÑA QUE QUIERES USAR
  const miNuevaClave = "Tetenet2026"; 

  console.log("Generando encriptación segura para la contraseña...");
  
  try {
    // Genera el hash con un "salto" de 10 (estándar de seguridad)
    const nuevoHash = await bcrypt.hash(miNuevaClave, 10);
    
    console.log(`🔑 Tu nueva contraseña es: ${miNuevaClave}`);
    console.log(`🔐 El código encriptado es: ${nuevoHash}`);
    
    // Actualizamos TODOS los usuarios en la base de datos con esta nueva clave
    console.log("⏳ Guardando en la base de datos...");
    const result = await db.query("UPDATE usuarios SET password_hash = $1", [nuevoHash]);
    
    console.log(`✅ ¡Éxito! Se actualizó la contraseña a ${result.rowCount} usuarios.`);
    console.log("Ya puedes iniciar sesión con cualquiera de los correos usando tu nueva clave.");

  } catch (error) {
    console.error("❌ Ocurrió un error:", error.message);
  } finally {
    await db.end();
  }
}

actualizarContraseñas();