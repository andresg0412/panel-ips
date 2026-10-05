// Cache en memoria por URL completa. El panel tiene pocos usuarios y una sola instancia,
// así que no hace falta Redis: evita repetir la misma consulta cuando varias personas
// miran la misma pantalla o cuando el navegador refresca.
// Guarda la promesa, no el resultado: dos peticiones simultáneas que necesitan el mismo cálculo (p. ej. el
// Resumen y la sala de control piden los mismos indicadores) comparten una sola consulta en curso.
const TTL_MS = 60_000;
const MAX_ENTRADAS = 300;

const entradas = new Map<string, { expira: number; valor: Promise<unknown> }>();

export function conCache<T>(clave: string, fn: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
  const ahora = Date.now();
  const hit = entradas.get(clave);
  if (hit && hit.expira > ahora) return hit.valor as Promise<T>;

  if (entradas.size >= MAX_ENTRADAS) {
    for (const [k, v] of entradas) if (v.expira <= ahora) entradas.delete(k);
    if (entradas.size >= MAX_ENTRADAS) entradas.delete(entradas.keys().next().value as string);
  }
  const valor = fn();
  const entrada = { expira: ahora + ttlMs, valor: valor as Promise<unknown> };
  entradas.set(clave, entrada);
  // Un error no se guarda: la próxima petición vuelve a intentar.
  valor.catch(() => {
    if (entradas.get(clave) === entrada) entradas.delete(clave);
  });
  return valor;
}
