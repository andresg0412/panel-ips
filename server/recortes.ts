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

/** Cifras de "En lista de espera ahora" que el Básico no recibe (el servidor las vacía; el frontend las oculta tras el candado). */
const AHORA_SIN_DESGLOSE = { con_oferta_en_curso: null, sin_cita_elegible: null, cupos_en_espera: null };

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

  // H2: el panorama calculaba todos los meses sin pasar por el límite de historial del plan. El recorte de meses
  // es siempre; el tiempo entre citas y el perfil de los pacientes son del plan Intermedio.
  'GET /api/pacientes/panorama': (req, d) => {
    const out = { ...d, mensual: recortarMeses(req, d.mensual, 'mes') };
    if (puede(req, 'pacientes.perfil')) return out;
    return { ...out, intervalos: [], perfil: [], resumenIntervalos: { n: 0, p25: null, mediana: null, p75: null } };
  },

  // H3: la ficha del profesional (Intermedio) no podía mostrar más de 365 días de historial.
  'GET /api/profesionales/ficha': (req, d) => ({ ...d, mensual: recortarMeses(req, d.mensual, 'mes') }),

  // H4: el Básico ve cuántas conversaciones hubo, cuántas se completaron o abandonaron y qué lograron
  // (`serie` y `resultado` se conservan). El resto de la lectura de las conversaciones es Intermedio.
  'GET /api/chatbot': (req, d) => {
    if (puede(req, 'chatbot.detalle')) return d;
    return {
      ...d,
      mapaCalor: [],
      conversion: [],
      primerFlujo: [],
      motivoFin: [],
      kpis: d.kpis ? { ...d.kpis, mediana_min: null, mensajes_promedio: null, fuera_horario: null, derivadas_fuera_horario: null } : d.kpis,
    };
  },

  // H5: citas por estado, especialidad y profesional (`serie`, `especialidad`, `profesional`) son Básico;
  // convenios, tipo de servicio, día, origen de la cancelación y últimos cambios son Intermedio.
  'GET /api/agenda': (req, d) =>
    puede(req, 'agenda.desglose') ? d : { ...d, administradora: [], servicio: [], diaSemana: [], origenCancelacion: [], cambios: [] },

  // H6: el Básico conserva enviados, fallidos, entregados y citas confirmadas. La lectura y la respuesta de los
  // pacientes (y las citas canceladas después del envío) son Intermedio. Se pone `null`, no 0, para que no se
  // confunda "no disponible en su plan" con "nadie respondió". Full conserva todo, así que Informe y Desempeño
  // (que leen este mismo endpoint) no se ven afectados.
  'GET /api/campanas': (req, d) => {
    if (puede(req, 'campanas.respuesta')) return d;
    return {
      ...d,
      porCampana: d.porCampana.map((f: Datos) => ({
        ...f,
        leidos: null,
        respondieron: null,
        respondieron_tarde: null,
        no_respondieron: null,
        pendientes: null,
        citas_canceladas: null,
      })),
    };
  },

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
        // H1: lo que la fase 3 del panel agregó al JSON. El Básico conserva solo las tres cifras de "ahora" que
        // muestra la tabla de niveles; el resto (desglose, pausadas por motivo, flujo y respuesta a ofertas) es Intermedio.
        ahora: d.ahora ? { activas: d.ahora.activas, esperando_cupo: d.ahora.esperando_cupo, pausadas: d.ahora.pausadas, ...AHORA_SIN_DESGLOSE } : d.ahora,
        pausadas: [],
        flujoPeriodo: [],
        flujoDiario: [],
        respuesta: { ofertas: 0, con_toque: 0, aceptaciones_perdidas: 0, minutos_a_leer: null, minutos_a_responder: null },
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
