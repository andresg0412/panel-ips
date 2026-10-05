// Etapa 6: predicción de inasistencia. Regresión logística simple y explicable, entrenada en el propio panel con las
// citas cerradas (asistió / no asistió) de días confiables. Cada rasgo es una categoría (historial del paciente,
// anticipación, día, franja, modalidad, servicio, pago, edad y respuesta al WhatsApp); su peso dice cuánto sube o
// baja el riesgo, y los pesos más altos de una cita son sus "motivos".
// Se presenta como herramienta para priorizar recordatorios, nunca como etiqueta del paciente (plan, riesgo 4.3-3).
import { query } from './db.js';
import { conCache } from './cache.js';
import { hoyBogota, sumarDias } from './params.js';
import { CITAS } from './sql.js';
import { contacto } from './sql2.js';

export interface FilaRasgos {
  agenda_id: string;
  fecha_cita: string;
  hora_cita: string | null;
  hora: number | null;
  dia: number;
  modalidad: string;
  tipo_servicio: string;
  tipo_pago: string;
  rango_edad: string;
  antic: number | null;
  faltas_previas: number;
  cerradas_previas: number;
  grupo: string;
  estado_agenda: string;
  grupo_contacto: string;
  nombre_paciente: string | null;
  profesional_nombre: string | null;
  especialidad: string | null;
}

/** Rasgos de las citas de pacientes entre $1 y $2. `cerradas`: para entrenar; si no, las programadas. */
const consulta = (cerradas: boolean) => `
  WITH ${CITAS},
  h AS (
    SELECT agenda_id, paciente_id, fecha_cita, hora_cita, hora, dia, modalidad, tipo_servicio, tipo_pago, rango_edad,
           anticipacion_registro_dias AS antic, grupo, periodo_confiable, estado_agenda, nombre_paciente,
           profesional_nombre, especialidad,
           count(*) FILTER (WHERE grupo = 'No asistió') OVER w AS faltas_previas,
           count(*) FILTER (WHERE grupo IN ('Asistió', 'No asistió')) OVER w AS cerradas_previas
      FROM citas
     WHERE es_cita_paciente AND paciente_id IS NOT NULL
    WINDOW w AS (PARTITION BY paciente_id ORDER BY fecha_cita, hora_cita, agenda_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
  ),
  ${contacto('$1', '$2')}
  SELECT h.agenda_id, h.fecha_cita, to_char(h.hora_cita, 'HH24:MI') AS hora_cita, h.hora, h.dia, h.modalidad, h.tipo_servicio,
         h.tipo_pago, h.rango_edad, h.antic, h.faltas_previas, h.cerradas_previas, h.grupo, h.estado_agenda,
         c.grupo_contacto, h.nombre_paciente, h.profesional_nombre, h.especialidad
    FROM h JOIN contacto c USING (agenda_id)
   WHERE h.fecha_cita BETWEEN $1 AND $2
     AND ${cerradas ? `h.grupo IN ('Asistió', 'No asistió') AND h.periodo_confiable` : `h.grupo = 'Programada'`}`;

// ------------------------------------------------------------------------------------------- rasgos
/** Texto de cada rasgo para explicar el riesgo (solo los que lo suben). */
const TEXTO: Record<string, string> = {
  'hist:2+_faltas': 'faltó 2 o más veces antes',
  'hist:1_falta': 'faltó una vez antes',
  'hist:tasa_alta': 'falta a muchas de sus citas',
  'hist:primera': 'es su primera cita',
  'antic:16+': 'se agendó con más de 15 días',
  'antic:8_15': 'se agendó con 8 a 15 días',
  'antic:4_7': 'se agendó con 4 a 7 días',
  'contacto:recibio_sin_confirmar': 'recibió el recordatorio y no confirmó',
  'contacto:sin_recordatorio': 'no ha recibido recordatorio',
  'contacto:sin_telefono_valido': 'no tiene celular válido',
  'contacto:envio_fallido': 'el recordatorio no le llegó',
  'modalidad:virtual': 'es virtual',
  'franja:temprano': 'es a primera hora',
  'franja:final': 'es al final de la tarde',
  'dia:1': 'es lunes',
  'dia:6': 'es sábado',
  'servicio:primera_vez': 'es de primera vez',
  'edad:18-29': 'paciente de 18 a 29 años',
  'edad:30-44': 'paciente de 30 a 44 años',
};

export function rasgos(f: FilaRasgos): string[] {
  const r: string[] = [];
  if (f.cerradas_previas === 0) r.push('hist:primera');
  else if (f.faltas_previas === 0) r.push('hist:sin_faltas');
  else if (f.faltas_previas === 1) r.push('hist:1_falta');
  else r.push('hist:2+_faltas');
  if (f.cerradas_previas >= 3 && f.faltas_previas / f.cerradas_previas >= 0.3) r.push('hist:tasa_alta');
  const d = f.antic;
  r.push(`antic:${d === null || d < 0 ? 'sd' : d === 0 ? 'mismo_dia' : d <= 3 ? '1_3' : d <= 7 ? '4_7' : d <= 15 ? '8_15' : '16+'}`);
  r.push(`dia:${f.dia}`);
  const h = f.hora ?? 12;
  r.push(`franja:${h < 9 ? 'temprano' : h < 12 ? 'manana' : h < 14 ? 'mediodia' : h < 17 ? 'tarde' : 'final'}`);
  r.push(`modalidad:${f.modalidad}`);
  r.push(`servicio:${['primera_vez', 'control', 'psicoterapia', 'evaluacion'].includes(f.tipo_servicio) ? f.tipo_servicio : 'otro'}`);
  r.push(`pago:${f.tipo_pago}`);
  r.push(`edad:${f.rango_edad}`);
  // Una cita futura ya confirmada por teléfono (estado Confirmado) cuenta como confirmada.
  r.push(`contacto:${f.estado_agenda === 'Confirmado' && f.grupo === 'Programada' ? 'confirmo_whatsapp' : f.grupo_contacto}`);
  return r;
}

// ----------------------------------------------------------------------------------- regresión logística
interface Modelo {
  sesgo: number;
  pesos: Record<string, number>;
}

const sigmoide = (z: number) => 1 / (1 + Math.exp(-z));

function entrenar(X: string[][], y: number[], iter = 300, tasa = 0.8, l2 = 0.002): Modelo {
  const claves = [...new Set(X.flat())];
  const idx = new Map(claves.map((k, i) => [k, i]));
  const w = new Float64Array(claves.length);
  const base = y.reduce((s, v) => s + v, 0) / y.length;
  let b = Math.log(base / (1 - base));
  const filas = X.map((x) => x.map((k) => idx.get(k)!));
  const n = y.length;
  for (let it = 0; it < iter; it++) {
    const g = new Float64Array(w.length);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (const j of filas[i]) z += w[j];
      const e = sigmoide(z) - y[i];
      gb += e;
      for (const j of filas[i]) g[j] += e;
    }
    b -= (tasa * gb) / n;
    for (let j = 0; j < w.length; j++) w[j] -= tasa * (g[j] / n + l2 * w[j]);
  }
  return { sesgo: b, pesos: Object.fromEntries(claves.map((k, i) => [k, w[i]])) };
}

const puntaje = (m: Modelo, x: string[]) => sigmoide(x.reduce((z, k) => z + (m.pesos[k] ?? 0), m.sesgo));

/** Área bajo la curva ROC (probabilidad de que una inasistencia tenga más riesgo que una asistencia). */
function auc(p: number[], y: number[]): number {
  const orden = p.map((v, i) => [v, y[i]] as const).sort((a, b) => a[0] - b[0]);
  let rango = 0;
  let pos = 0;
  orden.forEach(([, yi], i) => {
    if (yi) {
      rango += i + 1;
      pos++;
    }
  });
  const neg = orden.length - pos;
  return pos && neg ? (rango - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

const cuantil = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export interface Entrenado {
  modelo: Modelo;
  umbralAlto: number;
  umbralMedio: number;
  validacion: {
    desde: string;
    hasta: string;
    citas: number;
    base: number;
    auc: number;
    /** Inasistencia real de las citas marcadas como riesgo alto y del resto, en el período de validación. */
    tasaAlto: number;
    tasaResto: number;
    capturadas: number;
  };
  entrenadoCon: number;
  entrenadoAt: string;
}

/**
 * Entrena con las citas cerradas desde sep-2025 (ago-2025 es la carga inicial). Valida con las últimas 6 semanas,
 * que el modelo de validación no ve, y luego reentrena con todo. Se guarda 12 h en caché.
 */
export function modeloInasistencia(): Promise<Entrenado> {
  return conCache(
    'modelo-inasistencia',
    async () => {
      const ayer = sumarDias(hoyBogota(), -1);
      const corte = sumarDias(ayer, -41);
      const filas = await query<FilaRasgos>(consulta(true), ['2025-09-01', ayer]);
      const X = filas.map(rasgos);
      const y: number[] = filas.map((f) => (f.grupo === 'No asistió' ? 1 : 0));
      const ent = filas.map((f) => f.fecha_cita < corte);
      const Xe = X.filter((_, i) => ent[i]);
      const ye = y.filter((_, i) => ent[i]);
      const Xv = X.filter((_, i) => !ent[i]);
      const yv = y.filter((_, i) => !ent[i]);

      const mv = entrenar(Xe, ye);
      const pe = Xe.map((x) => puntaje(mv, x));
      const alto = cuantil(pe, 0.85);
      const pv = Xv.map((x) => puntaje(mv, x));
      const enAlto = pv.map((p) => p >= alto);
      const nAlto = enAlto.filter(Boolean).length;
      const faltasAlto = yv.filter((v, i) => v && enAlto[i]).length;
      const faltasTot = yv.reduce((s, v) => s + v, 0);

      const modelo = entrenar(X, y);
      const p = X.map((x) => puntaje(modelo, x));
      return {
        modelo,
        umbralAlto: cuantil(p, 0.85),
        umbralMedio: cuantil(p, 0.65),
        validacion: {
          desde: corte,
          hasta: ayer,
          citas: yv.length,
          base: yv.length ? faltasTot / yv.length : 0,
          auc: auc(pv, yv),
          tasaAlto: nAlto ? faltasAlto / nAlto : 0,
          tasaResto: yv.length - nAlto ? (faltasTot - faltasAlto) / (yv.length - nAlto) : 0,
          capturadas: faltasTot ? faltasAlto / faltasTot : 0,
        },
        entrenadoCon: y.length,
        entrenadoAt: new Date().toISOString(),
      };
    },
    12 * 3_600_000,
  );
}

export interface CitaRiesgo {
  fecha: string;
  hora: string | null;
  paciente: string | null;
  profesional: string | null;
  especialidad: string | null;
  modalidad: string;
  probabilidad: number;
  nivel: 'alto' | 'medio' | 'bajo';
  motivos: string[];
}

/** Citas programadas entre hoy y `dias` días adelante, con su riesgo y los motivos principales. */
export async function citasEnRiesgo(dias: number): Promise<{ entrenado: Entrenado; citas: CitaRiesgo[] }> {
  const entrenado = await modeloInasistencia();
  const hoy = hoyBogota();
  const filas = await query<FilaRasgos>(consulta(false), [hoy, sumarDias(hoy, dias)]);
  const m = entrenado.modelo;
  const citas = filas.map((f) => {
    const x = rasgos(f);
    const p = puntaje(m, x);
    const motivos = x
      .filter((k) => TEXTO[k] && (m.pesos[k] ?? 0) > 0.15)
      .sort((a, b) => (m.pesos[b] ?? 0) - (m.pesos[a] ?? 0))
      .slice(0, 3)
      .map((k) => TEXTO[k]);
    return {
      fecha: f.fecha_cita,
      hora: f.hora_cita,
      paciente: f.nombre_paciente,
      profesional: f.profesional_nombre,
      especialidad: f.especialidad,
      modalidad: f.modalidad,
      probabilidad: p,
      nivel: (p >= entrenado.umbralAlto ? 'alto' : p >= entrenado.umbralMedio ? 'medio' : 'bajo') as CitaRiesgo['nivel'],
      motivos,
    };
  });
  return { entrenado, citas };
}

/** Pesos legibles del modelo (para la explicación en la pantalla). */
export function factores(m: Modelo) {
  return Object.entries(m.pesos)
    .filter(([k]) => TEXTO[k])
    .map(([k, w]) => ({ clave: k, texto: TEXTO[k], efecto: Math.exp(w) }))
    .sort((a, b) => b.efecto - a.efecto);
}
