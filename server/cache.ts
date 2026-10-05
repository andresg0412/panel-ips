// Cache en memoria por URL completa. El panel tiene pocos usuarios y una sola instancia,
// así que no hace falta Redis: evita repetir la misma consulta cuando varias personas
// miran la misma pantalla o cuando el navegador refresca.
// Guarda la promesa, no el resultado: dos peticiones simultáneas que necesitan el mismo cálculo (p. ej. el
// Resumen y la sala de control piden los mismos indicadores) comparten una sola consulta en curso.
//
// Tras vencer, un valor sigue sirviéndose durante el período de gracia mientras se recalcula por detrás
// (stale-while-revalidate): quien vuelve a una pantalla la ve al instante y la siguiente visita trae el dato nuevo.
// El botón "Actualizar" no pasa por aquí con la misma clave (agrega _r), así que siempre recalcula.
const TTL_MS = 60_000;
const GRACIA_MS = 30 * 60_000;
const MAX_ENTRADAS = 300;

interface Entrada {
  expira: number;
  gracia: number;
  valor: Promise<unknown>;
  listo: boolean;
  refrescando: boolean;
}

const entradas = new Map<string, Entrada>();

/**
 * `graciaMs = 0` para datos que no deben mostrarse vencidos (alertas): al vencer se recalculan antes de responder.
 */
export function conCache<T>(clave: string, fn: () => Promise<T>, ttlMs = TTL_MS, graciaMs = GRACIA_MS): Promise<T> {
  const ahora = Date.now();
  const hit = entradas.get(clave);
  if (hit && hit.expira > ahora) return hit.valor as Promise<T>;
  if (hit && hit.listo && hit.expira + hit.gracia > ahora) {
    if (!hit.refrescando) refrescar(clave, hit, fn, ttlMs, graciaMs);
    return hit.valor as Promise<T>;
  }

  if (entradas.size >= MAX_ENTRADAS) {
    for (const [k, v] of entradas) if (v.expira + v.gracia <= ahora) entradas.delete(k);
    if (entradas.size >= MAX_ENTRADAS) entradas.delete(entradas.keys().next().value as string);
  }
  const valor = fn();
  const entrada: Entrada = { expira: ahora + ttlMs, gracia: graciaMs, valor: valor as Promise<unknown>, listo: false, refrescando: false };
  entradas.set(clave, entrada);
  // Un error no se guarda: la próxima petición vuelve a intentar.
  valor.then(
    () => { entrada.listo = true; },
    () => { if (entradas.get(clave) === entrada) entradas.delete(clave); },
  );
  return valor;
}

/** Recalcula por detrás un valor vencido; si falla, se conserva el anterior hasta que termine su gracia. */
function refrescar<T>(clave: string, viejo: Entrada, fn: () => Promise<T>, ttlMs: number, graciaMs: number) {
  viejo.refrescando = true;
  fn().then(
    (v) => {
      if (entradas.get(clave) !== viejo) return;
      entradas.set(clave, { expira: Date.now() + ttlMs, gracia: graciaMs, valor: Promise.resolve(v), listo: true, refrescando: false });
    },
    () => { viejo.refrescando = false; },
  );
}
