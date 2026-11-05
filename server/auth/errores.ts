// Error de la capa de autenticación: lleva el código HTTP y el `codigo` que decide el navegador (sección 10.2).
// El manejador global (server/errores.ts) lo convierte en `{ error, codigo }` y, si corresponde, en `Retry-After`.

export type CodigoAuth =
  | 'sesion' | 'credenciales' | 'temporal_vencida' | 'cambiar_contrasena' | 'reautenticar' | 'otp' | 'token' | 'politica'
  | 'historial' | 'actual' | 'origen' | 'limite' | 'correo' | 'no_existe' | 'datos';

export class ErrorAuth extends Error {
  constructor(
    readonly status: number,
    readonly codigo: CodigoAuth,
    mensaje: string,
    /** Segundos de espera, para el 429. */
    readonly reintentarEnS?: number,
  ) {
    super(mensaje);
  }
}

export const MENSAJES = {
  credenciales: 'Usuario o contraseña incorrectos',
  otp: 'Código incorrecto o vencido',
  token: 'El tiempo para cambiar su contraseña venció. Solicite un código nuevo.',
  sesion: 'Su sesión terminó',
  actual: 'La contraseña actual no es correcta',
  historial: 'Esa contraseña ya se usó antes. Elija una distinta.',
  politica: 'La contraseña no cumple los requisitos',
} as const;

export function limiteExcedido(segundos: number): ErrorAuth {
  const minutos = Math.max(1, Math.ceil(segundos / 60));
  return new ErrorAuth(429, 'limite', `Demasiados intentos. Intente de nuevo en ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}.`, Math.max(1, Math.ceil(segundos)));
}
