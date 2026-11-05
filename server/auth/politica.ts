// Reglas de la contraseña. Este archivo NO importa nada: lo usan el servidor (que decide) y el navegador (que solo
// ayuda con la lista de requisitos). Decisión D1: mínimo 8, minúscula, mayúscula, número y carácter especial.
export const LARGO_MIN = 8;
export const LARGO_MAX = 128;

export const REQUISITOS = [
  { clave: 'largo', texto: `Al menos ${LARGO_MIN} caracteres`, cumple: (c: string) => [...c].length >= LARGO_MIN },
  { clave: 'minuscula', texto: 'Una letra minúscula', cumple: (c: string) => /\p{Ll}/u.test(c) },
  { clave: 'mayuscula', texto: 'Una letra mayúscula', cumple: (c: string) => /\p{Lu}/u.test(c) },
  { clave: 'numero', texto: 'Un número', cumple: (c: string) => /\p{Nd}/u.test(c) },
  { clave: 'especial', texto: 'Un carácter especial', cumple: (c: string) => /[^\p{L}\p{N}\s]/u.test(c) },
] as const;

export const cumplePolitica = (c: string) => [...c].length <= LARGO_MAX && REQUISITOS.every((r) => r.cumple(c));
