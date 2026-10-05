import { createContext, useContext, type ReactNode } from 'react';

// Lo que el servidor dice que la persona puede ver (/api/yo). El servidor aplica las mismas reglas en cada
// consulta; aquí solo se decide qué pintar: contenido, candado (falta nivel) o nada (el rol no lo incluye).
export type Nivel = 'basico' | 'intermedio' | 'full';

export interface Evaluacion {
  ok: boolean;
  motivo?: 'rol' | 'nivel';
  nivel: Nivel;
}

export interface Yo {
  usuario: string | null;
  nombre: string | null;
  rol: string | null;
  rolNombre: string | null;
  rolReal: string | null;
  nivel: Nivel;
  nivelNombre: string;
  nivelReal: Nivel;
  vistaPrevia: boolean;
  historialDesde: string | null;
  habilitado: boolean;
  mensaje: string | null;
  /** Profesional de la agenda vinculado al usuario ("Mi agenda"). */
  profesional: string | null;
  inicio: string | null;
  paginas: Record<string, { estado: 'ok' | 'bloqueada' | 'oculta'; nivel: Nivel }>;
  funciones: Record<string, Evaluacion>;
  niveles: Record<Nivel, string>;
  roles: Record<string, string>;
}

export const AccesoCtx = createContext<Yo | null>(null);

export function useAcceso() {
  const yo = useContext(AccesoCtx);
  const ev = (clave: string): Evaluacion => yo?.funciones[clave] ?? { ok: false, motivo: 'rol', nivel: 'full' };
  return {
    yo,
    /** La persona puede usar la función. */
    puede: (clave: string) => ev(clave).ok,
    /** El rol la incluye (aunque el nivel no alcance): se muestra, con candado si hace falta. */
    visible: (clave: string) => ev(clave).motivo !== 'rol',
    nivelDe: (clave: string) => ev(clave).nivel,
    nombreNivel: (n: Nivel) => yo?.niveles[n] ?? n,
  };
}

export function Candado({ tam = 12, titulo }: { tam?: number; titulo?: string }) {
  return (
    <svg className="candado" width={tam} height={tam} viewBox="0 0 16 16" aria-hidden={titulo ? undefined : true} role={titulo ? 'img' : undefined}>
      {titulo && <title>{titulo}</title>}
      <path
        fill="currentColor"
        d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z"
      />
    </svg>
  );
}

/**
 * Tarjeta en lugar de una función que el nivel no incluye: una vista previa difuminada (decorativa, sin datos
 * reales), el nombre de la función y el plan que la incluye. Si el rol no la incluye, no se pinta nada.
 */
export function Bloqueado({ clave, titulo, alto = 180 }: { clave: string; titulo: string; alto?: number }) {
  const { yo, visible, nivelDe, nombreNivel } = useAcceso();
  if (!visible(clave)) return null;
  const nivel = nombreNivel(nivelDe(clave));
  const verPlanes = yo?.paginas.plan?.estado === 'ok';
  return (
    <section className="card bloqueado">
      <h3>{titulo}</h3>
      <div className="bloqueado-cuerpo" style={{ minHeight: alto }}>
        <div className="bloqueado-fondo" aria-hidden="true">
          {[42, 68, 55, 80, 61, 90, 72, 48, 66, 84, 58, 75].map((h, i) => (
            <span key={i} style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="bloqueado-aviso">
          <span className="bloqueado-icono"><Candado tam={16} /></span>
          <strong>Disponible en el plan {nivel}</strong>
          {verPlanes ? (
            <a className="boton" href="#/plan">Ver planes</a>
          ) : (
            <span className="ayuda" style={{ margin: 0 }}>Consulte con la dirección de la IPS.</span>
          )}
        </div>
      </div>
    </section>
  );
}

/** Muestra el contenido si la función está habilitada; si no, el candado (o nada, según el rol). */
export function Restringido({ clave, titulo, alto, children }: { clave: string; titulo: string; alto?: number; children: ReactNode }) {
  const { puede } = useAcceso();
  return puede(clave) ? <>{children}</> : <Bloqueado clave={clave} titulo={titulo} alto={alto} />;
}
