// Derivación y verificación de contraseñas con scrypt (node:crypto). Sección 8.4 y 11.2 de la especificación.
//
// Formato guardado: scrypt$<logN>$<r>$<p>$<sal base64url>$<hash base64url>. Los parámetros viajan en el propio hash,
// así se pueden subir más adelante y las cuentas viejas se rehacen solas tras un acceso correcto.
import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { CLAVE } from './configuracion.js';
import { cumplePolitica } from './politica.js';
import { limiteExcedido } from './errores.js';

// ------------------------------------------------------------------------------------- semáforo
/**
 * scrypt usa 32 MiB por operación y el contenedor tiene 256 MB (H19): solo `concurrencia` derivaciones a la vez, con
 * una cola corta. Cola llena = 429, no memoria agotada.
 */
class Semaforo {
  private activos = 0;
  private readonly cola: (() => void)[] = [];
  constructor(private readonly max: number, private readonly maxCola: number) {}

  async adquirir(): Promise<() => void> {
    if (this.activos >= this.max) {
      if (this.cola.length >= this.maxCola) throw limiteExcedido(ESPERA_COLA_LLENA_S);
      await new Promise<void>((resolver) => this.cola.push(resolver));
    } else {
      this.activos++;
    }
    let liberado = false;
    return () => {
      if (liberado) return;
      liberado = true;
      const siguiente = this.cola.shift();
      // El turno pasa directo al siguiente: `activos` no cambia.
      if (siguiente) siguiente();
      else this.activos--;
    };
  }
}

/** Cuánto se le pide esperar a quien llega con la cola llena. */
const ESPERA_COLA_LLENA_S = 30;

const semaforo = new Semaforo(CLAVE.concurrencia, CLAVE.cola);

function derivarBruto(clave: string, sal: Buffer, logN: number, r: number, p: number, largo: number): Promise<Buffer> {
  return new Promise((resolver, rechazar) => {
    scrypt(clave.normalize('NFKC'), sal, largo, { N: 2 ** logN, r, p, maxmem: CLAVE.maxmem }, (err, llave) => (err ? rechazar(err) : resolver(llave)));
  });
}

async function derivar(clave: string, sal: Buffer, logN: number, r: number, p: number, largo: number): Promise<Buffer> {
  const liberar = await semaforo.adquirir();
  try {
    return await derivarBruto(clave, sal, logN, r, p, largo);
  } finally {
    liberar();
  }
}

// ---------------------------------------------------------------------------------------- hash
interface HashLeido {
  logN: number;
  r: number;
  p: number;
  sal: Buffer;
  hash: Buffer;
}

function leerHash(almacenado: string): HashLeido | null {
  const partes = almacenado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return null;
  const [logN, r, p] = [Number(partes[1]), Number(partes[2]), Number(partes[3])];
  if (![logN, r, p].every((n) => Number.isInteger(n) && n > 0) || logN > 20 || r > 16 || p > 16) return null;
  const sal = Buffer.from(partes[4], 'base64url');
  const hash = Buffer.from(partes[5], 'base64url');
  return sal.length && hash.length ? { logN, r, p, sal, hash } : null;
}

/** Hash nuevo con los parámetros vigentes. */
export async function hashear(clave: string): Promise<string> {
  const sal = randomBytes(CLAVE.saltBytes);
  const hash = await derivar(clave, sal, CLAVE.logN, CLAVE.r, CLAVE.p, CLAVE.hashBytes);
  return ['scrypt', CLAVE.logN, CLAVE.r, CLAVE.p, sal.toString('base64url'), hash.toString('base64url')].join('$');
}

const sonVigentes = (h: HashLeido) => h.logN >= CLAVE.logN && h.r >= CLAVE.r && h.p >= CLAVE.p && h.hash.length >= CLAVE.hashBytes;

export interface ResultadoVerificacion {
  ok: boolean;
  /** El hash usa parámetros más débiles que los vigentes: conviene guardarlo de nuevo tras un acceso correcto. */
  rehacer: boolean;
}

/** Compara con `timingSafeEqual`. Un hash guardado ilegible nunca coincide. */
export async function verificar(clave: string, almacenado: string): Promise<ResultadoVerificacion> {
  const h = leerHash(almacenado);
  if (!h) return { ok: false, rehacer: false };
  const calculado = await derivar(clave, h.sal, h.logN, h.r, h.p, h.hash.length);
  const ok = calculado.length === h.hash.length && timingSafeEqual(calculado, h.hash);
  return { ok, rehacer: ok && !sonVigentes(h) };
}

let hashFicticio: Promise<string> | null = null;

/** Calcula desde ya el hash ficticio, para que ningún acceso pague el costo de la primera vez. */
export function precalentarContrasenas(): Promise<string> {
  hashFicticio ??= hashear(randomBytes(24).toString('base64url'));
  return hashFicticio;
}

/**
 * Deriva contra un hash fijo calculado al arrancar. Se usa cuando la cuenta no existe, está inactiva o no tiene
 * credencial, para que esos casos tarden lo mismo que una contraseña errada (H23).
 */
export async function verificarFicticia(clave: string): Promise<void> {
  await verificar(clave, await precalentarContrasenas());
}

// -------------------------------------------------------------------------------------- temporal
const MINUSCULAS = 'abcdefghjkmnpqrstuvwxyz';
const MAYUSCULAS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITOS = '23456789';
const ESPECIALES = '!#$%&*+-=?@';
const TODOS = MINUSCULAS + MAYUSCULAS + DIGITOS + ESPECIALES;
const uno = (alfabeto: string) => alfabeto[randomInt(alfabeto.length)];

/** Contraseña temporal aleatoria de 16 caracteres que cumple la política (sin caracteres ambiguos como l, 1, O, 0). */
export function generarTemporal(): string {
  for (;;) {
    const c = [uno(MINUSCULAS), uno(MAYUSCULAS), uno(DIGITOS), uno(ESPECIALES)];
    while (c.length < CLAVE.temporalLargo) c.push(uno(TODOS));
    for (let i = c.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [c[i], c[j]] = [c[j], c[i]];
    }
    const t = c.join('');
    if (cumplePolitica(t)) return t;
  }
}
