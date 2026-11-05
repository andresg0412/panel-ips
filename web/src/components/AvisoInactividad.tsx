import { useEffect, useRef, useState } from 'react';
import { enviarJson } from '../api';
import { AVISO_INACTIVIDAD_MS, LATIDO_MS, alCambiarToque, ultimoToque } from '../sesion';

/** Eventos de la persona que cuentan como "sigue aquí". Los movimientos del ratón pasan por el mismo límite de 5 minutos. */
const EVENTOS_ACTIVIDAD = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'mousemove'] as const;

/** Espera mínima entre dos confirmaciones de un vencimiento con el servidor. */
const REINTENTO_MS = 10_000;

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function latido() {
  // Si el servidor ya venció la sesión, esta llamada recibe el 401 y api.ts lleva a la pantalla de acceso.
  await enviarJson('POST', '/api/auth/latido').catch(() => {});
}

/**
 * Mantiene viva la sesión mientras la persona trabaja y le avisa antes de que venza por inactividad (RF-36).
 *  - Latido: ante actividad real, como máximo UNO cada 5 minutos (las consultas automáticas no cuentan).
 *  - Aviso: 2 minutos antes de vencer, una ventana con "Seguir conectado" o "Cerrar sesión".
 * Se calcula sobre el último contacto que el SERVIDOR registró, no sobre el ratón: así el aviso nunca llega tarde.
 */
export default function AvisoInactividad({ inactividadMin, onSalir }: { inactividadMin: number; onSalir: () => void }) {
  const limiteMs = inactividadMin * 60_000;
  const [restante, setRestante] = useState<number | null>(null);
  const enviando = useRef(false);
  // Si el latido falla (sin red), no se insiste cada segundo.
  const ultimoIntento = useRef(0);
  const botonSeguir = useRef<HTMLButtonElement>(null);

  // Latido por actividad de la persona.
  useEffect(() => {
    const alActuar = () => {
      if (enviando.current || document.visibilityState !== 'visible') return;
      if (Date.now() - ultimoToque() < LATIDO_MS) return;
      enviando.current = true;
      void latido().finally(() => (enviando.current = false));
    };
    for (const ev of EVENTOS_ACTIVIDAD) window.addEventListener(ev, alActuar, { passive: true, capture: true });
    return () => {
      for (const ev of EVENTOS_ACTIVIDAD) window.removeEventListener(ev, alActuar, { capture: true });
    };
  }, []);

  // Cuenta regresiva hacia el vencimiento.
  useEffect(() => {
    const revisar = () => {
      const faltan = ultimoToque() + limiteMs - Date.now();
      if (faltan <= 0) {
        // Venció (o eso cree este navegador): se confirma con el servidor. Si otra pestaña la renovó, sigue viva.
        if (!enviando.current && Date.now() - ultimoIntento.current > REINTENTO_MS) {
          enviando.current = true;
          ultimoIntento.current = Date.now();
          void latido().finally(() => (enviando.current = false));
        }
        setRestante(null);
      } else {
        setRestante(faltan <= AVISO_INACTIVIDAD_MS ? faltan : null);
      }
    };
    revisar();
    const t = setInterval(revisar, 1000);
    // Si otra pestaña (o una petición) renueva la sesión, la ventana se cierra sola.
    const quitar = alCambiarToque(revisar);
    return () => {
      clearInterval(t);
      quitar();
    };
  }, [limiteMs]);

  useEffect(() => {
    if (restante !== null) botonSeguir.current?.focus();
  }, [restante === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (restante === null) return null;
  return (
    <div className="ventana-velo">
      <div className="ventana" role="alertdialog" aria-modal="true" aria-labelledby="inactividad-titulo" aria-describedby="inactividad-texto">
        <h2 id="inactividad-titulo">¿Sigue ahí?</h2>
        <p id="inactividad-texto">
          Por seguridad, su sesión se cerrará en <b>{mmss(restante)}</b> si no hay actividad.
        </p>
        <div className="ventana-acciones">
          <button ref={botonSeguir} className="boton boton-primario" onClick={() => void latido()}>Seguir conectado</button>
          <button className="boton" onClick={onSalir}>Cerrar sesión</button>
        </div>
      </div>
    </div>
  );
}
