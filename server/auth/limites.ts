// Contadores en memoria contra la fuerza bruta (sección 8.2). Hay un solo proceso: un reinicio los reinicia, y es
// una limitación aceptada. Los contadores usan el identificador normalizado EXISTA O NO la cuenta (H23): así el
// límite no revela nada.
import { LIMITES, type ReglaLimite } from './configuracion.js';
import { limiteExcedido } from './errores.js';

interface Entrada {
  n: number;
  inicio: number;
  /** Instante hasta el cual la clave está bloqueada (0 = libre). */
  hasta: number;
}

export class Limitador {
  private readonly entradas = new Map<string, Entrada>();
  constructor(readonly regla: ReglaLimite) {}

  private vigente(clave: string, ahora: number): Entrada | undefined {
    const e = this.entradas.get(clave);
    if (!e) return undefined;
    if (e.hasta > ahora) return e;
    // Bloqueo terminado o ventana vencida: la clave vuelve a empezar.
    if (e.hasta || ahora - e.inicio >= this.regla.ventanaMs) {
      this.entradas.delete(clave);
      return undefined;
    }
    return e;
  }

  /** Segundos que faltan para que la clave quede libre (0 si no está bloqueada). */
  espera(clave: string, ahora = Date.now()): number {
    const e = this.vigente(clave, ahora);
    return e && e.hasta > ahora ? Math.ceil((e.hasta - ahora) / 1000) : 0;
  }

  /** Cuenta un fallo. Devuelve true si con este fallo la clave pasó a estar bloqueada. */
  fallo(clave: string, ahora = Date.now()): boolean {
    let e = this.vigente(clave, ahora);
    if (!e) {
      e = { n: 0, inicio: ahora, hasta: 0 };
      this.entradas.set(clave, e);
    }
    if (e.hasta > ahora) return false;
    e.n++;
    if (e.n < this.regla.tope) return false;
    e.hasta = ahora + this.regla.bloqueoMs;
    return true;
  }

  /**
   * Cuenta una solicitud (no un fallo) y dice si se permite. Para los límites "N por ventana" donde se sigue
   * respondiendo igual pero sin procesar.
   */
  intentar(clave: string, ahora = Date.now()): boolean {
    if (this.espera(clave, ahora) > 0) return false;
    this.fallo(clave, ahora);
    // Se cuenta incluso la que llegó al tope: esa sí se permite, la siguiente no.
    return true;
  }

  limpiar(clave: string) {
    this.entradas.delete(clave);
  }

  /** Borra todas las claves que empiezan con el prefijo (desbloqueo de una cuenta desde cualquier IP). */
  limpiarPrefijo(prefijo: string) {
    for (const k of this.entradas.keys()) if (k.startsWith(prefijo)) this.entradas.delete(k);
  }

  /** La clave, o alguna que empiece con el prefijo, está bloqueada ahora. */
  bloqueadaPrefijo(prefijo: string, ahora = Date.now()): boolean {
    for (const [k, e] of this.entradas) if (k.startsWith(prefijo) && e.hasta > ahora) return true;
    return false;
  }

  purgar(ahora = Date.now()) {
    for (const [k, e] of this.entradas) {
      if (e.hasta ? e.hasta <= ahora : ahora - e.inicio >= this.regla.ventanaMs) this.entradas.delete(k);
    }
  }

  vaciar() {
    this.entradas.clear();
  }

  get tamano() {
    return this.entradas.size;
  }
}


export const limites = {
  loginIp: new Limitador(LIMITES.loginIp),
  loginIdentificadorIp: new Limitador(LIMITES.loginIdentificadorIp),
  loginIdentificador: new Limitador(LIMITES.loginIdentificador),
  recuperarIp: new Limitador(LIMITES.recuperarIp),
  otpCorreoIp: new Limitador(LIMITES.otpCorreoIp),
  otpIp: new Limitador(LIMITES.otpIp),
  contrasenaUsuario: new Limitador(LIMITES.contrasenaUsuario),
};

/** Para que el `Map` no crezca sin límite con claves de IP que ya no vuelven. */
const PURGA_MS = 5 * 60_000;
const temporizador = setInterval(() => Object.values(limites).forEach((l) => l.purgar()), PURGA_MS);
temporizador.unref();

export const vaciarLimites = () => Object.values(limites).forEach((l) => l.vaciar());

/** Identificador digitado en el login, normalizado igual exista o no la cuenta. */
export const normalizarIdentificador = (s: string) => s.normalize('NFKC').trim().toLowerCase();

// ------------------------------------------------------------------------------------------ login
export const claveIdIp = (id: string, ip: string) => `${id}|${ip}`;

/** Lanza 429 si alguno de los tres límites del login está bloqueado. */
export function exigirLoginPermitido(ip: string, id: string) {
  const espera = Math.max(
    limites.loginIp.espera(ip),
    limites.loginIdentificadorIp.espera(claveIdIp(id, ip)),
    limites.loginIdentificador.espera(id),
  );
  if (espera > 0) throw limiteExcedido(espera);
}

/** Cuenta un fallo de login en los tres límites. Devuelve true si la CUENTA (identificador) quedó bloqueada. */
export function registrarFalloLogin(ip: string, id: string): boolean {
  limites.loginIp.fallo(ip);
  limites.loginIdentificadorIp.fallo(claveIdIp(id, ip));
  return limites.loginIdentificador.fallo(id);
}

export function registrarLoginCorrecto(ip: string, id: string) {
  limites.loginIdentificadorIp.limpiar(claveIdIp(id, ip));
}

/** Soporte desbloquea una cuenta: se borran los contadores de todos sus identificadores desde cualquier IP. */
export function desbloquearIdentificadores(ids: (string | null | undefined)[]) {
  for (const bruto of ids) {
    if (!bruto) continue;
    const id = normalizarIdentificador(bruto);
    limites.loginIdentificador.limpiar(id);
    limites.loginIdentificadorIp.limpiarPrefijo(`${id}|`);
  }
}

export function cuentaBloqueada(ids: (string | null | undefined)[]): boolean {
  return ids.some((bruto) => {
    if (!bruto) return false;
    const id = normalizarIdentificador(bruto);
    return limites.loginIdentificador.espera(id) > 0 || limites.loginIdentificadorIp.bloqueadaPrefijo(`${id}|`);
  });
}
