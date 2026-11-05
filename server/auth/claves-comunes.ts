// Contraseñas prohibidas, solo en el servidor y sin servicios externos (sección 8.4 de la especificación).
// La política de composición (política.ts) deja pasar claves como "Password1!" que cumplen todas las reglas y están
// entre las primeras que prueba un atacante; esta lista las cierra.

/** Raíces habituales. Cada una se prueba sola y con los finales más comunes. */
const RAICES = [
  'password', 'passw0rd', 'contrasena', 'contraseña', 'clave', 'claves', 'admin', 'administrador', 'administrator', 'root',
  'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'abc', 'abcd', 'abcdef', 'abcdefg', 'letmein',
  'welcome', 'bienvenido', 'bienvenida', 'hola', 'holamundo', 'hello', 'secret', 'secreto', 'login', 'master', 'dragon',
  'monkey', 'football', 'futbol', 'baseball', 'soccer', 'shadow', 'sunshine', 'princess', 'superman', 'batman', 'iloveyou',
  'tequiero', 'teamo', 'colombia', 'bogota', 'medellin', 'cali', 'barranquilla', 'cartagena', 'millonarios', 'nacional',
  'america', 'junior', 'santafe', 'panel', 'panelips', 'ips', 'soporte', 'gerencia', 'analista', 'marketing', 'profesional',
  'centro', 'orientacion', 'salud', 'psicologia', 'terapia', 'usuario', 'user', 'test', 'prueba', 'temporal', 'cambiame',
  'cambiar', 'cambio', 'default', 'guest', 'invitado', 'changeme', 'trustno1', 'whatever', 'freedom', 'michael', 'jessica',
  'daniel', 'maria', 'carlos', 'andres', 'sofia', 'valentina', 'camila', 'juan', 'jose', 'luis', 'pedro', 'diana',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  'verano', 'invierno', 'primavera', 'otono', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
  'ingreso', 'acceso', 'entrar', 'sistema', 'servidor', 'computador', 'internet', 'google', 'gmail', 'hotmail', 'facebook',
  'whatsapp', 'zentrix', 'qazwsx', 'qazwsxedc', '1qaz2wsx', 'zaq12wsx', 'q1w2e3r4', '1q2w3e4r', 'iloveu', 'pokemon', 'naruto',
];

const FINALES = [
  '', '1', '12', '123', '1234', '12345', '123456', '!', '1!', '12!', '123!', '1234!', '@', '#', '*', '.', '$', '!!', '1@', '123@',
  '2020', '2021', '2022', '2023', '2024', '2025', '2026', '2020!', '2021!', '2022!', '2023!', '2024!', '2025!', '2026!',
  '2020*', '2021*', '2022*', '2023*', '2024*', '2025*', '2026*', '!1', '@1', '#1', '01', '007', '777', '000', '321', '321!', '7',
];

/** Secuencias que, en cualquier posición, hacen la clave trivial. */
const SUBCADENAS_PROHIBIDAS = ['orientacion', 'password', 'contraseña', 'contrasena', 'qwerty', '123456', 'abcdef', 'asdfgh'];

const CONJUNTO_RAICES = new Set(RAICES);

/** Todas las variantes exactas (raíz + final, también con la inicial en mayúscula, que al comparar en minúscula coincide). */
const EXACTAS = new Set<string>();
for (const raiz of RAICES) for (const f of FINALES) EXACTAS.add(raiz + f);

const normalizar = (s: string) => s.normalize('NFKC').toLowerCase();

/** Quita los dígitos y símbolos del final: "Password#9482" → "password". */
const sinFinal = (s: string) => s.replace(/[\d!@#$%^&*()_+=.,;:?¡¿\-]+$/u, '');

/** Quita la sustitución leetspeak más común, para que "P@ssw0rd" caiga como "password". */
const sinLeet = (s: string) => s.replace(/@/g, 'a').replace(/0/g, 'o').replace(/\$/g, 's').replace(/1/g, 'i').replace(/3/g, 'e').replace(/!/g, 'i');

export interface ContextoClave {
  usuario?: string | null;
  correo?: string | null;
}

/** Fragmentos del usuario que la contraseña no puede contener (3 o más caracteres). */
function fragmentosPersonales({ usuario, correo }: ContextoClave): string[] {
  const out: string[] = [];
  if (usuario) out.push(normalizar(usuario));
  if (correo) out.push(normalizar(correo.split('@')[0] ?? ''));
  return out.filter((f) => [...f].length >= 3);
}

/**
 * La contraseña es prohibida si, en minúsculas: está en la lista de comunes (con o sin finales típicos), contiene
 * el usuario o la parte local del correo, o contiene alguna de las secuencias de SUBCADENAS_PROHIBIDAS.
 * El mensaje que ve la persona es el mismo en todos los casos, para no orientar a un atacante.
 */
export function esClaveProhibida(clave: string, ctx: ContextoClave = {}): boolean {
  const c = normalizar(clave);
  if (EXACTAS.has(c)) return true;
  const tronco = sinFinal(c);
  if (tronco !== c && (CONJUNTO_RAICES.has(tronco) || EXACTAS.has(tronco))) return true;
  const destronada = sinLeet(c);
  if (EXACTAS.has(destronada) || CONJUNTO_RAICES.has(sinFinal(destronada))) return true;
  if (SUBCADENAS_PROHIBIDAS.some((s) => c.includes(s) || destronada.includes(s))) return true;
  return fragmentosPersonales(ctx).some((f) => c.includes(f));
}

export const MENSAJE_CLAVE_PROHIBIDA = 'Esa contraseña es muy común o contiene su usuario. Elija otra.';
