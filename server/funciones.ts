// Niveles de licencia, roles y catálogo de funciones del panel: la única fuente de verdad sobre quién ve qué.
// El servidor la aplica en cada petición (acceso.ts) y el frontend la recibe en /api/yo para pintar el menú y
// los candados. Plan: proyecto-ips/docs/features/2026-10-04-panel-valor-niveles-soporte-plan.md, secciones 2 y 3.

export type Nivel = 'basico' | 'intermedio' | 'full';
export const NIVELES: Nivel[] = ['basico', 'intermedio', 'full'];
export const NOMBRE_NIVEL: Record<Nivel, string> = { basico: 'Básico', intermedio: 'Intermedio', full: 'Full' };
export const rangoNivel = (n: Nivel) => NIVELES.indexOf(n);
export const esNivel = (v: unknown): v is Nivel => typeof v === 'string' && (NIVELES as string[]).includes(v);

/** Días de historial consultables por nivel (null = desde el inicio de los datos). */
export const HISTORIAL_DIAS: Record<Nivel, number | null> = { basico: 90, intermedio: 365, full: null };
/** Usuarios activos por nivel, sin contar soporte (null = sin límite). */
export const MAX_USUARIOS: Record<Nivel, number | null> = { basico: 1, intermedio: 4, full: null };

export type Pagina =
  | 'resumen' | 'campanas' | 'agenda' | 'capacidad' | 'profesionales' | 'chatbot' | 'lista-espera' | 'pacientes' | 'marketing'
  | 'alertas' | 'plan' | 'mi-agenda' | 'soporte';

export type Rol = 'direccion' | 'operacion' | 'analista' | 'relacion' | 'profesional' | 'soporte';
export const esRol = (v: unknown): v is Rol => typeof v === 'string' && v in ROLES;

const CLIENTE: Pagina[] = ['resumen', 'campanas', 'agenda', 'capacidad', 'profesionales', 'chatbot', 'lista-espera', 'pacientes', 'marketing', 'alertas', 'plan'];

export const ROLES: Record<Rol, { nombre: string; inicio: Pagina; paginas: Pagina[] }> = {
  direccion: { nombre: 'Dirección', inicio: 'resumen', paginas: CLIENTE },
  analista: { nombre: 'Analista', inicio: 'resumen', paginas: CLIENTE },
  operacion: { nombre: 'Operación', inicio: 'agenda', paginas: ['agenda', 'capacidad', 'profesionales', 'lista-espera', 'alertas'] },
  relacion: { nombre: 'Relación con pacientes', inicio: 'campanas', paginas: ['campanas', 'chatbot', 'pacientes', 'marketing', 'alertas'] },
  // "Mi agenda": solo los datos del profesional vinculado al usuario (Etapa 4), más los agregados generales.
  profesional: { nombre: 'Profesional', inicio: 'mi-agenda', paginas: ['mi-agenda', 'resumen'] },
  soporte: { nombre: 'Soporte', inicio: 'soporte', paginas: [...CLIENTE, 'mi-agenda', 'soporte'] },
};

export interface Funcion {
  clave: string;
  /** Pantalla a la que pertenece; null = transversal (depende solo del nivel y de `roles`). */
  pagina: Pagina | null;
  nivel: Nivel;
  /** Texto para la comparación de planes. */
  titulo: string;
  /** Si se indica, además de tener la página, el rol debe estar en esta lista. */
  roles?: Rol[];
}

export const FUNCIONES: Funcion[] = [
  { clave: 'resumen.kpis', pagina: 'resumen', nivel: 'basico', titulo: 'Indicadores principales y gráficos del período' },
  { clave: 'resumen.comparacion', pagina: 'resumen', nivel: 'intermedio', titulo: 'Comparación con el período anterior' },
  { clave: 'resumen.metas', pagina: 'resumen', nivel: 'intermedio', titulo: 'Metas con semáforo, ocupación y pacientes nuevos' },
  { clave: 'resumen.tendencia', pagina: 'resumen', nivel: 'intermedio', titulo: 'Tendencia mensual por especialidad' },
  {
    clave: 'resumen.sala',
    pagina: 'resumen',
    nivel: 'intermedio',
    titulo: 'Sala de control: lo más relevante del período, lo que requiere atención y la tendencia de cada indicador',
  },
  { clave: 'metas.editar', pagina: 'resumen', nivel: 'full', titulo: 'Definir las metas de los indicadores', roles: ['direccion'] },

  { clave: 'agenda.periodo', pagina: 'agenda', nivel: 'basico', titulo: 'Citas por estado, especialidad y profesional' },
  { clave: 'agenda.inasistencia', pagina: 'agenda', nivel: 'intermedio', titulo: 'Mapa de la inasistencia y anticipación de cancelaciones' },
  { clave: 'agenda.tendencias', pagina: 'agenda', nivel: 'intermedio', titulo: 'Tendencias: cancelación, teleconsulta, convenios y días de espera' },
  { clave: 'agenda.calidad', pagina: 'agenda', nivel: 'intermedio', titulo: 'Calidad de los datos de la agenda' },
  { clave: 'agenda.proximas', pagina: 'agenda', nivel: 'full', titulo: 'Proyección de las próximas semanas' },

  { clave: 'capacidad.cancelaciones', pagina: 'capacidad', nivel: 'intermedio', titulo: 'Cupos que se liberan por cancelaciones y reprogramaciones' },
  { clave: 'capacidad.modalidad', pagina: 'capacidad', nivel: 'intermedio', titulo: 'Presencial frente a virtual' },
  {
    clave: 'capacidad.centro',
    pagina: 'capacidad',
    nivel: 'full',
    titulo: 'Centro de capacidad: cupos ofrecidos y ocupados, capacidad sin usar por día y hora, y días de espera',
  },
  { clave: 'capacidad.recuperables', pagina: 'capacidad', nivel: 'full', titulo: 'Citas recuperables con la lista de espera' },

  { clave: 'miagenda.ver', pagina: 'mi-agenda', nivel: 'intermedio', titulo: 'Mi agenda: citas, pacientes que faltan y ocupación de cada profesional' },

  { clave: 'profesionales.lista', pagina: 'profesionales', nivel: 'basico', titulo: 'Citas y asistencia por profesional' },
  { clave: 'profesionales.ficha', pagina: 'profesionales', nivel: 'intermedio', titulo: 'Ficha detallada de cada profesional' },
  { clave: 'profesionales.ocupacion', pagina: 'profesionales', nivel: 'intermedio', titulo: 'Ocupación de la agenda' },
  { clave: 'profesionales.capacidad', pagina: 'profesionales', nivel: 'full', titulo: 'Cupos libres de los próximos 14 días y retención por profesional' },

  { clave: 'campanas.resultados', pagina: 'campanas', nivel: 'basico', titulo: 'Mensajes enviados y resultados por campaña' },
  { clave: 'campanas.detalle', pagina: 'campanas', nivel: 'intermedio', titulo: 'Detalle de cada mensaje enviado' },
  { clave: 'campanas.calidad', pagina: 'campanas', nivel: 'intermedio', titulo: 'Errores de entrega y calidad de los teléfonos' },
  { clave: 'campanas.efecto', pagina: 'campanas', nivel: 'intermedio', titulo: 'Efecto de las campañas en la asistencia' },
  { clave: 'campanas.ejecuciones', pagina: 'campanas', nivel: 'intermedio', titulo: 'Calendario de ejecuciones de las campañas' },
  { clave: 'campanas.tiempos', pagina: 'campanas', nivel: 'full', titulo: 'Tiempos de lectura y de respuesta' },
  { clave: 'campanas.rankings', pagina: 'campanas', nivel: 'full', titulo: 'Rankings de campañas: más efectivas, con más respuesta y con más fallos' },
  { clave: 'campanas.fatiga', pagina: 'campanas', nivel: 'full', titulo: 'Fatiga de mensajes: quién recibe demasiados y si responde menos' },

  { clave: 'chatbot.conversaciones', pagina: 'chatbot', nivel: 'basico', titulo: 'Conversaciones con el asistente de WhatsApp' },
  { clave: 'chatbot.historia', pagina: 'chatbot', nivel: 'intermedio', titulo: 'Embudo de las conversaciones y trámites resueltos sin recepción' },
  { clave: 'chatbot.embudo', pagina: 'chatbot', nivel: 'intermedio', titulo: 'Recorrido paso a paso de cada trámite' },
  { clave: 'chatbot.ahorro', pagina: 'chatbot', nivel: 'full', titulo: 'Horas de recepción ahorradas por el bot' },
  { clave: 'chatbot.oportunidades', pagina: 'chatbot', nivel: 'full', titulo: 'Oportunidades de mejora del bot, en frases' },
  { clave: 'parametros.editar', pagina: 'chatbot', nivel: 'full', titulo: 'Ajustar los minutos por trámite', roles: ['direccion'] },
  { clave: 'chatbot.demanda', pagina: 'chatbot', nivel: 'full', titulo: 'Demanda que el bot no convierte y mensajes no entendidos' },

  { clave: 'pacientes.panorama', pagina: 'pacientes', nivel: 'basico', titulo: 'Pacientes nuevos y recurrentes' },
  { clave: 'pacientes.retencion', pagina: 'pacientes', nivel: 'intermedio', titulo: 'Retención, cohortes y pacientes en riesgo' },
  { clave: 'pacientes.buscar', pagina: 'pacientes', nivel: 'intermedio', titulo: 'Búsqueda y ficha de un paciente', roles: ['direccion', 'analista', 'relacion'] },

  { clave: 'listaEspera.inscritos', pagina: 'lista-espera', nivel: 'basico', titulo: 'Inscritos activos en la lista de espera' },
  { clave: 'listaEspera.detalle', pagina: 'lista-espera', nivel: 'intermedio', titulo: 'Cupos recuperados, ofertas y motivos' },
  { clave: 'listaEspera.invitaciones', pagina: 'lista-espera', nivel: 'full', titulo: 'Campañas de invitación a la lista de espera' },

  { clave: 'marketing.alcance', pagina: 'marketing', nivel: 'intermedio', titulo: 'Alcance de WhatsApp por mes' },
  { clave: 'marketing.segmentos', pagina: 'marketing', nivel: 'full', titulo: 'Segmentos de pacientes para invitar a volver' },

  { clave: 'alertas.conteo', pagina: 'alertas', nivel: 'basico', titulo: 'Número de alertas activas' },
  { clave: 'alertas.panel', pagina: 'alertas', nivel: 'intermedio', titulo: 'Alertas operativas y salud de los datos' },
  { clave: 'alertas.revisar', pagina: 'alertas', nivel: 'intermedio', titulo: 'Marcar alertas como revisadas', roles: ['direccion', 'operacion'] },
  { clave: 'confianza', pagina: null, nivel: 'intermedio', titulo: 'Índice de confianza de los datos' },

  { clave: 'exportar.csv', pagina: null, nivel: 'intermedio', titulo: 'Descargar tablas en CSV' },
  {
    clave: 'exportar.personales',
    pagina: null,
    nivel: 'full',
    titulo: 'Descargar listados con datos de contacto de pacientes',
    roles: ['direccion', 'analista'],
  },

  { clave: 'plan.ver', pagina: 'plan', nivel: 'basico', titulo: 'Comparación de planes' },
];

const POR_CLAVE = new Map(FUNCIONES.map((f) => [f.clave, f]));
export const funcion = (clave: string) => POR_CLAVE.get(clave);

/**
 * Función que exige cada endpoint ("MÉTODO url-de-la-ruta"). Un endpoint de /api que no esté aquí, ni en
 * LIBRES ni bajo /api/soporte/, se rechaza: así una ruta nueva no queda abierta por olvido.
 */
export const ENDPOINTS: Record<string, string> = {
  'GET /api/resumen': 'resumen.kpis',
  'GET /api/resumen/series': 'resumen.kpis',
  'GET /api/resumen/metas': 'resumen.metas',
  'GET /api/resumen/tendencia': 'resumen.tendencia',
  'GET /api/resumen/sala': 'resumen.sala',
  'GET /api/metas': 'resumen.metas',
  'PUT /api/metas': 'metas.editar',
  'GET /api/confianza': 'confianza',

  'GET /api/agenda': 'agenda.periodo',
  'GET /api/agenda/inasistencia': 'agenda.inasistencia',
  'GET /api/agenda/cancelaciones': 'agenda.inasistencia',
  'GET /api/agenda/historico': 'agenda.tendencias',
  'GET /api/agenda/calidad': 'agenda.calidad',
  'GET /api/agenda/proximas': 'agenda.proximas',

  'GET /api/capacidad': 'capacidad.centro',
  'GET /api/capacidad/recuperables': 'capacidad.recuperables',
  'GET /api/capacidad/cancelaciones': 'capacidad.cancelaciones',
  'GET /api/capacidad/modalidad': 'capacidad.modalidad',
  'GET /api/mi-agenda': 'miagenda.ver',

  'GET /api/profesionales': 'profesionales.lista',
  'GET /api/profesionales/ficha': 'profesionales.ficha',
  'GET /api/profesionales/ocupacion': 'profesionales.ocupacion',

  'GET /api/campanas': 'campanas.resultados',
  'GET /api/campanas/envios': 'campanas.detalle',
  'GET /api/campanas/calidad': 'campanas.calidad',
  'GET /api/campanas/telefonos-invalidos': 'exportar.personales',
  'GET /api/campanas/embudo': 'campanas.efecto',
  'GET /api/campanas/contacto': 'campanas.efecto',
  'GET /api/campanas/recuperacion': 'campanas.efecto',
  'GET /api/campanas/ejecuciones': 'campanas.ejecuciones',
  'GET /api/campanas/tiempos': 'campanas.tiempos',
  'GET /api/campanas/fatiga': 'campanas.fatiga',

  'GET /api/chatbot': 'chatbot.conversaciones',
  'GET /api/chatbot/embudo': 'chatbot.embudo',
  'GET /api/chatbot/demanda': 'chatbot.demanda',
  'GET /api/chatbot/historia': 'chatbot.historia',
  'GET /api/chatbot/ahorro': 'chatbot.ahorro',
  'GET /api/chatbot/oportunidades': 'chatbot.oportunidades',
  'PUT /api/parametros': 'parametros.editar',

  'GET /api/pacientes/panorama': 'pacientes.panorama',
  'GET /api/pacientes/ciclo': 'pacientes.retencion',
  'GET /api/pacientes/en-riesgo': 'exportar.personales',
  'GET /api/pacientes/buscar': 'pacientes.buscar',
  'GET /api/pacientes/:id': 'pacientes.buscar',

  'GET /api/lista-espera': 'listaEspera.inscritos',
  'GET /api/marketing': 'marketing.alcance',

  'GET /api/alertas/conteo': 'alertas.conteo',
  'GET /api/alertas': 'alertas.panel',
  'GET /api/alertas/salud': 'alertas.panel',
  'POST /api/alertas/revisar': 'alertas.revisar',
  'GET /api/sistema': 'alertas.panel',

  'GET /api/plan': 'plan.ver',
};

/** Endpoints que no dependen de nivel ni de rol (sí de tener un usuario válido, salvo /api/health). */
export const LIBRES = new Set(['GET /api/health', 'GET /api/yo', 'GET /api/incidentes', 'POST /api/actividad']);

/**
 * Las páginas de detalle de envíos piden 50 filas; la descarga, hasta 5.000. Más de este tamaño se considera
 * exportación de datos personales.
 */
export const TAM_MAX_SIN_EXPORTAR = 100;

/** Funcionalidades del plan Full que todavía no existen (se muestran como "en desarrollo" en Mi plan). */
export const PROXIMAMENTE: { titulo: string; nivel: Nivel }[] = [
  { titulo: 'Informe ejecutivo mensual en PDF', nivel: 'full' },
  { titulo: 'Resumen semanal por correo', nivel: 'full' },
  { titulo: 'Predicción de inasistencia y detección de anomalías', nivel: 'full' },
];
