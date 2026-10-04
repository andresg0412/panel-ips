// Cache en memoria por URL completa. El panel tiene pocos usuarios y una sola instancia,
// así que no hace falta Redis: evita repetir la misma consulta cuando varias personas
// miran la misma pantalla o cuando el navegador refresca.
const TTL_MS = 60_000;
const MAX_ENTRADAS = 300;

const entradas = new Map<string, { expira: number; valor: unknown }>();

export async function conCache<T>(clave: string, fn: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
  const ahora = Date.now();
  const hit = entradas.get(clave);
  if (hit && hit.expira > ahora) return hit.valor as T;

  const valor = await fn();
  if (entradas.size >= MAX_ENTRADAS) {
    for (const [k, v] of entradas) if (v.expira <= ahora) entradas.delete(k);
    if (entradas.size >= MAX_ENTRADAS) entradas.delete(entradas.keys().next().value as string);
  }
  entradas.set(clave, { expira: ahora + ttlMs, valor });
  return valor;
}
