const nf = new Intl.NumberFormat('es-CO');

export const num = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : nf.format(Number(v)));

export function pct(parte: number, total: number, decimales = 1): string {
  if (!total) return '—';
  return `${((parte / total) * 100).toFixed(decimales).replace('.', ',')} %`;
}

export function ratio(parte: number, total: number): number | null {
  return total ? parte / total : null;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** 'YYYY-MM-DD' → '4 oct 2026' */
export function fecha(v: unknown): string {
  if (!v) return '—';
  const s = String(v);
  const [a, m, d] = s.slice(0, 10).split('-').map(Number);
  if (!a) return s;
  return `${d} ${MESES[m - 1]} ${a}`;
}

/** 'YYYY-MM-DD' → '4 oct' (ejes de gráficos) */
export function fechaCorta(v: unknown): string {
  const [, m, d] = String(v).slice(0, 10).split('-').map(Number);
  return m ? `${d} ${MESES[m - 1]}` : String(v);
}

/** 'YYYY-MM' → 'ago 25' (ejes mensuales) */
export function mesCorto(v: unknown): string {
  const [a, m] = String(v).split('-').map(Number);
  return m ? `${MESES[m - 1]} ${String(a).slice(2)}` : String(v);
}

/** Proporción → '12,3 %' */
export const tasaTxt = (v: number | null | undefined, decimales = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(decimales).replace('.', ',')} %`;

/** Timestamp ya en hora de Bogotá 'YYYY-MM-DDTHH:MM:SS' → '4 oct 2026, 14:32' */
export function fechaHora(v: unknown): string {
  if (!v) return '—';
  const s = String(v);
  return `${fecha(s)}, ${s.slice(11, 16)}`;
}

export const hora = (v: unknown) => (v ? String(v).slice(0, 5) : '—');

/** Minutos transcurridos desde un timestamp de Bogotá, comparado con la hora actual de Bogotá. */
export function minutosDesde(v: unknown, ahoraBogota: string): number | null {
  if (!v) return null;
  return (Date.parse(`${ahoraBogota}Z`) - Date.parse(`${String(v)}Z`)) / 60_000;
}

export function haceCuanto(min: number | null): string {
  if (min === null) return 'sin datos';
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${Math.round(min)} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} días`;
}

export const DIAS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const ETIQUETAS: Record<string, string> = {
  // campañas
  execute: 'Confirmación 24 h',
  reminder: 'Recordatorio 48 h',
  daily: 'Recordatorio 2 h',
  recuperacion: 'Recuperación de pacientes',
  conasistencia: 'Seguimiento post-cita',
  oferta_cupo: 'Oferta de cupo',
  aviso_asesor: 'Aviso a asesor',
  invitacion_regularizacion: 'Invitación lista de espera (regularización)',
  invitacion_continua: 'Invitación lista de espera',
  // respuesta a envíos
  respondio: 'Respondió',
  respondio_tarde: 'Respondió tarde',
  no_respondio: 'No respondió',
  pendiente: 'Esperando respuesta',
  no_aplica: 'Envío fallido',
  // resultados de conversación
  sin_gestion: 'Sin trámite (consulta o respuesta)',
  derivado_agente: 'Pasó a un asesor',
  fuera_horario: 'Fuera de horario',
  cita_creada: 'Agendó cita',
  cita_cancelada: 'Canceló cita',
  cita_reprogramada: 'Reprogramó cita',
  cita_confirmada: 'Confirmó cita',
  error_backend: 'Error del sistema',
  // flujos
  campana_respuesta: 'Respuesta a campaña',
  inicio: 'Saludo inicial',
  agente: 'Hablar con asesor',
  agendar: 'Agendar cita',
  cancelar: 'Cancelar cita',
  reprogramar: 'Reprogramar cita',
  politicas: 'Política de datos',
  pqrs: 'PQRS',
  conocer_ips: 'Conocer la IPS',
  lista_espera: 'Lista de espera',
  menu: 'Menú',
  sin_dato: 'Sin dato',
  // tipos de servicio
  primera_vez: 'Primera vez',
  control: 'Control / seguimiento',
  psicoterapia: 'Psicoterapia',
  evaluacion: 'Evaluación y pruebas',
  crisis: 'Intervención en crisis',
  rehabilitacion: 'Rehabilitación',
  empresarial: 'Talleres y programas',
  otro: 'Otro',
  administrativa: 'Reuniones internas',
  // modalidad, pago, edad, anticipación
  presencial: 'Presencial',
  virtual: 'Virtual',
  particular: 'Particular',
  convenio: 'Convenio / EPS',
  '0-11': '0 a 11 años',
  '12-17': '12 a 17 años',
  '18-29': '18 a 29 años',
  '30-44': '30 a 44 años',
  '45-59': '45 a 59 años',
  '60+': '60 años o más',
  a_mismo_dia: 'Agendada el mismo día',
  b_1_3: '1 a 3 días antes',
  c_4_7: '4 a 7 días antes',
  d_8_15: '8 a 15 días antes',
  e_16_mas: '16 días o más antes',
  z_sin_dato: 'Sin dato',
  // motivos de cierre de cupos
  fila_agotada: 'Nadie en la fila aceptó',
  sin_candidatos: 'No había inscritos para ese cupo',
  // lista de espera
  activa: 'Activa',
  pausada: 'Pausada',
  retirada: 'Retirada',
  consumida: 'Atendida (usó un cupo)',
  detectado: 'Detectado',
  en_oferta: 'En oferta',
  asignado: 'Asignado',
  escalado: 'Pasó a recepción',
  expirado: 'Expirado',
  cerrado_manual: 'Cerrado manualmente',
  en_cola: 'En cola',
  enviada: 'Enviada',
  aceptada: 'Aceptada',
  rechazada: 'Rechazada',
  expirada: 'Expirada sin respuesta',
  anulada: 'Anulada',
  error: 'Error',
  // origen de cancelación / cambios
  paciente_bot: 'Paciente, por el bot',
  recepcion: 'Recepción',
  sistema: 'Sistema',
  profesional: 'Profesional',
  sin_registro: 'Globho / recepción (sin detalle)',
  scraper: 'Globho',
  bot: 'Bot',
  cascada: 'Lista de espera',
};

/** Traduce un código interno a texto para el cliente; si no lo conoce, lo humaniza. */
export function etiqueta(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'Sin dato';
  const s = String(v);
  if (ETIQUETAS[s]) return ETIQUETAS[s];
  const h = s.replace(/_/g, ' ');
  return h.charAt(0).toUpperCase() + h.slice(1);
}
