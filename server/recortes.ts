// Partes de una respuesta que dependen del nivel de licencia. Se aplican después de la ruta (y de su caché), antes
// de enviar: así las rutas no cambian y todas las reglas por nivel quedan juntas. Nunca se modifica el objeto
// original, porque puede estar en la caché compartida entre niveles.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { puede, recortarMeses } from './acceso.js';

type Datos = Record<string, any>;
type Recorte = (req: FastifyRequest, d: Datos) => Datos;

/** "1098765432" → "10******32". Muestra lo justo para reconocer el dato sin revelarlo. */
export function enmascarar(v: unknown): unknown {
  if (typeof v !== 'string' || !v) return v;
  if (v.includes('@')) {
    const [u, dominio] = v.split('@');
    return `${u.slice(0, 1)}***@${dominio}`;
  }
  return v.length <= 4 ? '****' : `${v.slice(0, 2)}${'*'.repeat(v.length - 4)}${v.slice(-2)}`;
}

const CAMPOS_PERSONALES = ['documento_paciente', 'numero_documento', 'telefono_norm', 'numero_contacto', 'email', 'documento'];

/** Enmascara documento, teléfono y correo de cada fila si la persona no tiene `datos.identidad`. */
const enmascararFilas = (req: FastifyRequest, filas: Datos[]) =>
  puede(req, 'datos.identidad')
    ? filas
    : filas.map((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, CAMPOS_PERSONALES.includes(k) ? enmascarar(v) : v])));

const RECORTES: Record<string, Recorte> = {
  'GET /api/campanas/envios': (req, d) => ({ ...d, filas: enmascararFilas(req, d.filas) }),
  'GET /api/pacientes/buscar': (req, d) => ({ ...d, filas: enmascararFilas(req, d.filas) }),
  'GET /api/envios/invitacion/previsualizar': (req, d) => ({ ...d, filas: enmascararFilas(req, d.filas) }),
  'GET /api/pacientes/:id': (req, d) => (d.paciente ? { ...d, paciente: enmascararFilas(req, [d.paciente])[0] } : d),

  'GET /api/resumen': (req, d) =>
    puede(req, 'resumen.comparacion') ? d : { ...d, anterior: null, comparacion: { tipo: 'ninguna', desde: null, hasta: null } },

  'GET /api/resumen/tendencia': (req, d) => ({ ...d, filas: recortarMeses(req, d.filas, 'mes') }),

  'GET /api/agenda/historico': (req, d) => ({
    ...d,
    mensual: recortarMeses(req, d.mensual, 'mes'),
    servicios: recortarMeses(req, d.servicios, 'mes'),
    espera: recortarMeses(req, d.espera, 'mes'),
  }),

  'GET /api/profesionales': (req, d) =>
    puede(req, 'profesionales.capacidad')
      ? d
      : { ...d, filas: d.filas.map(({ nuevos_cohorte: _n, volvieron: _v, ...f }: Datos) => ({ ...f, nuevos_cohorte: null, volvieron: null })) },

  'GET /api/profesionales/ocupacion': (req, d) => (puede(req, 'profesionales.capacidad') ? d : { ...d, libres: [] }),

  'GET /api/pacientes/ciclo': (req, d) => ({ ...d, cohortes: recortarMeses(req, d.cohortes, 'cohorte') }),

  'GET /api/campanas/recuperacion': (req, d) => ({ ...d, filas: recortarMeses(req, d.filas, 'mes') }),

  'GET /api/marketing': (req, d) => ({
    ...d,
    alcance: recortarMeses(req, d.alcance, 'mes'),
    segmentos: puede(req, 'marketing.segmentos') ? d.segmentos : [],
  }),

  'GET /api/lista-espera': (req, d) => {
    let out = d;
    if (!puede(req, 'listaEspera.detalle')) {
      out = {
        ...out,
        inscripciones: [],
        cupos: [],
        ofertas: [],
        cuposRecientes: [],
        ofertasRecientes: [],
        motivos: [],
        embudo: { cupos: 0, con_oferta: 0, aceptados: 0, asignados: 0, horas_recuperadas: 0, minutos_hasta_asignar: null, recolocadas_atendidas: 0 },
      };
    }
    if (!puede(req, 'listaEspera.invitaciones')) out = { ...out, invitaciones: [], ejecuciones: [], invitacionesPorTipo: [] };
    return out;
  },
};

export function instalarRecortes(app: FastifyInstance) {
  app.addHook('preSerialization', async (req: FastifyRequest, reply, payload) => {
    if (reply.statusCode !== 200 || !req.routeOptions.url || !payload || typeof payload !== 'object') return payload;
    const fn = RECORTES[`${req.method} ${req.routeOptions.url}`];
    return fn ? fn(req, payload as Datos) : payload;
  });
}
