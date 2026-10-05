// Incidentes de datos conocidos (TR-01). Períodos en que el sistema no registró bien la información: el panel
// los sombrea en los gráficos y no compara contra ellos. Desde la Etapa 1 viven en panel.incidentes y se editan
// en la consola de soporte; esta lista es la carga inicial y el respaldo si esa tabla no responde.
// Fechas en hora de Bogotá, ambas inclusive. Fuente: docs/catalogo-analitica.md, hallazgo D1.
import { poolApp } from './db.js';

export type AreaIncidente = 'general' | 'agenda' | 'whatsapp' | 'conversaciones' | 'eventos' | 'trazabilidad';

export interface Incidente {
  area: AreaIncidente;
  desde: string;
  hasta: string;
  titulo: string;
  descripcion: string;
}

export const INCIDENTES_BASE: Incidente[] = [
  {
    area: 'general',
    desde: '2026-04-01',
    hasta: '2026-08-05',
    titulo: 'Incidente abril-agosto 2026: el bot no funcionó',
    descripcion: 'El bot tuvo errores y prácticamente no funcionó. Los datos de este período están incompletos.',
  },
  {
    area: 'whatsapp',
    desde: '2026-04-01',
    hasta: '2026-06-22',
    titulo: 'Envíos de campañas rechazados',
    descripcion: 'WhatsApp rechazó casi todos los mensajes de campaña: los pacientes no recibieron recordatorios.',
  },
  {
    area: 'whatsapp',
    desde: '2026-06-23',
    hasta: '2026-08-05',
    titulo: 'Campañas detenidas',
    descripcion: 'No se registró ningún envío de campañas.',
  },
  {
    area: 'conversaciones',
    desde: '2026-04-01',
    hasta: '2026-08-06',
    titulo: 'Sin conversaciones registradas',
    descripcion: 'El bot no registró conversaciones con pacientes.',
  },
  {
    area: 'agenda',
    desde: '2026-05-30',
    hasta: '2026-08-05',
    titulo: 'Sincronización con Globho detenida',
    descripcion: 'No se copiaron citas nuevas desde Globho; las citas de junio quedaron sin estado final.',
  },
  {
    area: 'trazabilidad',
    desde: '2026-10-01',
    hasta: '2026-10-03',
    titulo: 'Envíos sin registrar',
    descripcion: 'Las campañas sí se enviaron, pero no quedaron en el registro detallado de envíos.',
  },
];

export const AREAS_INCIDENTE: AreaIncidente[] = ['general', 'agenda', 'whatsapp', 'conversaciones', 'eventos', 'trazabilidad'];

let actuales: Incidente[] = INCIDENTES_BASE;

/** Incidentes vigentes (última lectura de panel.incidentes). */
export function incidentes(): Incidente[] {
  return actuales;
}

/** Vuelve a leer panel.incidentes. Si falla, conserva la última lista buena. */
export async function recargarIncidentes(): Promise<void> {
  if (!poolApp) return;
  const { rows } = await poolApp.query<Incidente>(
    `SELECT area, desde::text AS desde, hasta::text AS hasta, titulo, descripcion FROM panel.incidentes ORDER BY desde, id`,
  );
  actuales = rows;
}
