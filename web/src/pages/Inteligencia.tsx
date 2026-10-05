// Etapa 6 · Inteligencia (plan Full): predicción de inasistencia, pacientes que se alejan, anomalías y simulador.
// Todo se presenta como apoyo para decidir y priorizar, con su precisión y sus supuestos a la vista.
import { useMemo, useState } from 'react';
import { conRango, getJson, useApi, type Rango } from '../api';
import { confirmarDescargaPersonal, descargarCsv, Estado, Info, Tabla, Tarjeta, type Columna } from '../components/ui';
import { ListaFrases, type Frase } from '../components/sala';
import { Bloqueado, useAcceso } from '../acceso';
import { Pestanas, usePestana } from '../incidentes';
import { DIAS, fecha, num, pct, tasaTxt } from '../format';

const diaTxt = (f: string) => `${DIAS[((new Date(`${f}T12:00:00Z`).getUTCDay() + 6) % 7) + 1]} ${fecha(f)}`;

// ------------------------------------------------------------------------------------------ predicción
interface CitaRiesgo {
  fecha: string;
  hora: string | null;
  paciente: string | null;
  profesional: string | null;
  especialidad: string | null;
  modalidad: string;
  probabilidad: number;
  nivel: 'alto' | 'medio';
  motivos: string[];
}
interface Prediccion {
  validacion: { desde: string; hasta: string; citas: number; base: number; auc: number; tasaAlto: number; tasaResto: number; capturadas: number };
  entrenadoCon: number;
  entrenadoAt: string;
  factores: { clave: string; texto: string; efecto: number }[];
  dias: { fecha: string; citas: number; alto: number; medio: number }[];
  lista: CitaRiesgo[];
}

const COLS_RIESGO: Columna<CitaRiesgo>[] = [
  { clave: 'fecha', titulo: 'Día', formato: (v) => diaTxt(v) },
  { clave: 'hora', titulo: 'Hora' },
  { clave: 'paciente', titulo: 'Paciente' },
  { clave: 'profesional', titulo: 'Profesional' },
  {
    clave: 'nivel',
    titulo: 'Riesgo',
    formato: (v) => <span className={`sello ${v === 'alto' ? 'sello-mal' : 'sello-cerca'}`}>{v === 'alto' ? 'Alto' : 'Medio'}</span>,
    orden: (f) => f.probabilidad,
  },
  { clave: 'motivos', titulo: 'Por qué', formato: (v: string[]) => (v.length ? v.join('; ') : '—'), envolver: true },
];

function PrediccionInasistencia() {
  const { data, error, cargando } = useApi<Prediccion>('/api/inteligencia/prediccion', 600_000);
  const [soloAlto, setSoloAlto] = useState(true);
  if (error || !data) return <Estado cargando={cargando} error={error} hayDatos={!!data} />;
  const v = data.validacion;
  const veces = v.tasaResto ? v.tasaAlto / v.tasaResto : null;
  const lista = soloAlto ? data.lista.filter((c) => c.nivel === 'alto') : data.lista;
  return (
    <>
      <Tarjeta
        titulo="¿Qué citas de los próximos días tienen más riesgo de que el paciente no llegue?"
        marcas={[{ tipo: 'estimada', detalle: 'Es una predicción a partir del historial: orienta a quién reforzar el recordatorio, no dice quién faltará.' }]}
        ayuda="Citas programadas de hoy y los dos días siguientes, según la probabilidad de inasistencia que estima el modelo."
      >
        <div className="cifras">
          {data.dias.map((d) => (
            <div className="cifra" key={d.fecha}>
              <div className="n">{num(d.alto)}</div>
              <div className="t">
                <b>{diaTxt(d.fecha)}</b>: citas con riesgo alto de {num(d.citas)} ({num(d.medio)} con riesgo medio)
              </div>
            </div>
          ))}
        </div>
        <p className="frase" style={{ marginTop: 14 }}>
          En las últimas 6 semanas, las citas que el modelo marcaba con riesgo alto faltaron el <b>{tasaTxt(v.tasaAlto, 0)}</b> de las veces, frente al{' '}
          {tasaTxt(v.tasaResto, 0)} del resto{veces && veces >= 1.3 ? ` (unas ${String(Math.round(veces * 10) / 10).replace('.', ',')} veces más)` : ''}. Sirve para
          priorizar llamadas y recordatorios: concentra el {tasaTxt(v.capturadas, 0)} de las inasistencias en el 15 % de las citas.
        </p>
      </Tarjeta>
      <Tarjeta
        titulo="Citas para reforzar el recordatorio"
        marcas={[{ tipo: 'personales' }]}
        ayuda="Una llamada o un mensaje de recepción el día anterior. Nunca se muestra al paciente ni al profesional como una etiqueta."
        accion={
          <label className="ayuda" style={{ margin: 0, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={!soloAlto} onChange={(e) => setSoloAlto(!e.target.checked)} /> Incluir riesgo medio
          </label>
        }
      >
        <Tabla filas={lista} columnas={COLS_RIESGO} vacio="Sin citas con riesgo alto en los próximos días" />
      </Tarjeta>
      <div className="grid g2">
        <Tarjeta titulo="¿Qué sube el riesgo?" ayuda="Cuánto se multiplica la probabilidad de faltar con cada factor, frente a una cita sin él.">
          <ul className="lista-simple">
            {data.factores.map((f) => (
              <li key={f.clave}>
                <span>{f.texto.charAt(0).toUpperCase() + f.texto.slice(1)}</span>
                <span>× {String(Math.round(f.efecto * 100) / 100).replace('.', ',')}</span>
              </li>
            ))}
          </ul>
        </Tarjeta>
        <Tarjeta titulo="Cómo funciona" ayuda="Para leer las cifras con la cautela correcta.">
          <ul className="lista-simple">
            <li><span>Citas con las que aprendió</span><span>{num(data.entrenadoCon)}</span></li>
            <li><span>Inasistencia habitual</span><span>{tasaTxt(v.base, 1)}</span></li>
            <li>
              <span>
                Capacidad para distinguir <Info texto="AUC: probabilidad de que una cita que terminó en inasistencia tuviera más riesgo que una atendida. 50 % es azar; 100 %, perfecto." />
              </span>
              <span>{tasaTxt(v.auc, 0)}</span>
            </li>
            <li><span>Validado con</span><span>{num(v.citas)} citas del {fecha(v.desde)} al {fecha(v.hasta)}</span></li>
          </ul>
          <p className="nota">
            Un modelo simple y explicable (regresión logística) sobre el historial de cada paciente, la anticipación, el día, la hora, la modalidad, el tipo de atención y su
            respuesta al WhatsApp. Se reentrena cada 12 horas. Es modesto: ayuda a ordenar a quién llamar primero, no a adivinar.
          </p>
        </Tarjeta>
      </div>
    </>
  );
}

// -------------------------------------------------------------------------------------------- abandono
interface Alejado {
  paciente: string | null;
  especialidad: string | null;
  profesional: string | null;
  ultima: string;
  dias_sin_venir: number;
  frecuencia: number | null;
  atenciones: number;
}
const COLS_ALEJADO: Columna<Alejado>[] = [
  { clave: 'paciente', titulo: 'Paciente' },
  { clave: 'atenciones', titulo: 'Atenciones', num: true },
  { clave: 'frecuencia', titulo: 'Venía cada', num: true, formato: (v) => (v ? `${num(v)} días` : '—') },
  { clave: 'dias_sin_venir', titulo: 'Días sin venir', num: true },
  { clave: 'ultima', titulo: 'Última atención', formato: (v) => fecha(v) },
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'profesional', titulo: 'Profesional' },
];
const ESTADOS: [string, string, string][] = [
  ['activo_con_cita', 'Con cita programada', 'Tiene una próxima cita agendada.'],
  ['activo', 'Activos', 'Vino hace poco, dentro de su frecuencia habitual.'],
  ['en_riesgo', 'Se están alejando', 'Pasó más del doble de su frecuencia habitual sin volver, hasta 120 días.'],
  ['inactivo', 'Inactivos', 'Más de 120 días sin venir.'],
];

function Abandono() {
  const { data, error, cargando } = useApi<{ estados: { estado: string; n: number }[]; lista: Alejado[] }>('/api/inteligencia/abandono', 600_000);
  const { puede } = useAcceso();
  const [bajando, setBajando] = useState(false);
  const descargar = async () => {
    if (!confirmarDescargaPersonal('el listado de pacientes que se están alejando')) return;
    setBajando(true);
    try {
      const d = await getJson<{ filas: Record<string, unknown>[] }>('/api/pacientes/en-riesgo');
      const cols = Object.keys(d.filas[0] ?? {}).map((k) => ({ clave: k, titulo: k }));
      descargarCsv('pacientes_que_se_alejan', d.filas, cols, true);
    } finally {
      setBajando(false);
    }
  };
  if (error || !data) return <Estado cargando={cargando} error={error} hayDatos={!!data} />;
  const n = (k: string) => data.estados.find((e) => e.estado === k)?.n ?? 0;
  const total = data.estados.reduce((s, e) => s + e.n, 0);
  return (
    <>
      <Tarjeta titulo="¿Quiénes se están alejando?" ayuda="Pacientes atendidos desde agosto de 2025, según cuánto llevan sin venir frente a su propia frecuencia habitual.">
        <div className="cifras">
          {ESTADOS.map(([k, t, d]) => (
            <div className="cifra" key={k}>
              <div className="n">{num(n(k))}</div>
              <div className="t">
                {t} ({pct(n(k), total, 0)}) <Info texto={d} />
              </div>
            </div>
          ))}
        </div>
      </Tarjeta>
      <Tarjeta
        titulo="A quién invitar a volver primero"
        marcas={[{ tipo: 'personales' }]}
        ayuda="Los 100 pacientes que se están alejando con más atenciones previas: los más vinculados a la IPS, donde una llamada o la campaña de recuperación tiene más sentido."
        accion={
          puede('exportar.personales') ? (
            <button className="boton" disabled={bajando} onClick={descargar}>{bajando ? 'Preparando…' : 'Descargar todos para la campaña'}</button>
          ) : undefined
        }
      >
        <Tabla filas={data.lista} columnas={COLS_ALEJADO} vacio="Ningún paciente se está alejando en este momento" />
      </Tarjeta>
    </>
  );
}

// ------------------------------------------------------------------------------------------- anomalías
function Anomalias() {
  const { data, error, cargando } = useApi<{ anomalias: (Frase & { fecha: string })[] }>('/api/inteligencia/anomalias', 600_000);
  if (error || !data) return <Estado cargando={cargando} error={error} hayDatos={!!data} forma="bloque" />;
  return (
    <Tarjeta
      titulo="Días fuera de lo normal"
      ayuda="Cada día de las últimas dos semanas se compara con el mismo día de la semana en las 8 semanas anteriores. Solo aparecen desvíos grandes; se ignoran domingos y días con incidentes de datos."
    >
      {data.anomalias.length ? (
        <ListaFrases frases={data.anomalias} />
      ) : (
        <p className="vacio">Ningún día de las últimas dos semanas se salió de lo normal en citas, cancelaciones, inasistencias, conversaciones o mensajes.</p>
      )}
      <p className="nota">Las que empeoran algo (en rojo) también aparecen en "Qué requiere atención" del Resumen durante una semana.</p>
    </Tarjeta>
  );
}

// ------------------------------------------------------------------------------------------- simulador
interface Base {
  actual: { citas: Record<string, number> };
}

function Deslizador({ etiqueta, valor, min, max, paso, sufijo, onCambio }: { etiqueta: string; valor: number; min: number; max: number; paso: number; sufijo: string; onCambio: (v: number) => void }) {
  return (
    <label className="deslizador">
      <span>{etiqueta}</span>
      <input type="range" min={min} max={max} step={paso} value={valor} onChange={(e) => onCambio(Number(e.target.value))} />
      <b>{valor > 0 && min < 0 ? '+' : ''}{String(valor).replace('.', ',')} {sufijo}</b>
    </label>
  );
}

function Simulador({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Base>(conRango('/api/resumen', rango), 300_000);
  const [asis, setAsis] = useState(2);
  const [canc, setCanc] = useState(3);
  const [recol, setRecol] = useState(10);
  const calc = useMemo(() => {
    if (!data) return null;
    const c = data.actual.citas;
    const dias = Math.round((Date.parse(rango.hasta) - Date.parse(rango.desde)) / 86_400_000) + 1;
    const f = 30.4 / dias;
    const debian = c.asistio + c.no_asistio;
    if (!debian || !c.total) return null;
    const a0 = c.asistio / debian;
    const nc0 = (c.canceladas + c.reprogramadas) / c.total;
    const a1 = Math.min(0.995, a0 + asis / 100);
    const nc1 = Math.max(0, nc0 - canc / 100);
    // Por mes: citas que hoy ocurren y las que dejarían de cancelarse; los cupos liberados que la lista recoloca.
    const total = c.total * f;
    const ocurren0 = total * (1 - nc0);
    const ocurren1 = total * (1 - nc1);
    const liberadas1 = total * nc1;
    const recolocadas = liberadas1 * (recol / 100);
    const atendidas0 = ocurren0 * a0;
    const atendidas1 = (ocurren1 + recolocadas) * a1;
    return { dias, a0, a1, nc0, nc1, atendidas0, atendidas1, extra: atendidas1 - atendidas0, recolocadas, liberadas1 };
  }, [data, rango, asis, canc, recol]);

  if (error || !data) return <Estado cargando={cargando} error={error} hayDatos={!!data} forma="bloque" />;
  if (!calc) return <p className="vacio">Sin citas suficientes en el período para simular. Elija un período más largo.</p>;
  return (
    <div className="grid g2">
      <Tarjeta titulo="¿Qué pasaría si…?" ayuda={`Parte de lo ocurrido del ${fecha(rango.desde)} al ${fecha(rango.hasta)} y lo lleva a un mes. Mueva los controles.`}>
        <div className="deslizadores">
          <Deslizador etiqueta={`La asistencia sube (hoy ${tasaTxt(calc.a0, 1)})`} valor={asis} min={0} max={6} paso={0.5} sufijo="puntos" onCambio={setAsis} />
          <Deslizador etiqueta={`Las cancelaciones y reprogramaciones bajan (hoy ${tasaTxt(calc.nc0, 0)})`} valor={canc} min={0} max={15} paso={1} sufijo="puntos" onCambio={setCanc} />
          <Deslizador etiqueta="La lista de espera recoloca de los cupos liberados" valor={recol} min={0} max={50} paso={5} sufijo="%" onCambio={setRecol} />
        </div>
      </Tarjeta>
      <Tarjeta
        titulo="Resultado estimado por mes"
        marcas={[{ tipo: 'estimada', detalle: 'Proyección con supuestos simples: misma demanda, misma duración de cita y que los cupos recolocados se atienden con la nueva asistencia.' }]}
      >
        <div className="ahorro-cabeza">
          <div>
            <div className="ahorro-horas">
              +{num(Math.round(calc.extra))}
              <small>citas atendidas al mes</small>
            </div>
            <div className="nota" style={{ marginTop: 4 }}>
              unas {num(Math.round((calc.extra * 50) / 60))} horas más de consulta (citas de 50 minutos)
            </div>
          </div>
        </div>
        <ul className="lista-simple">
          <li><span>Atendidas al mes hoy</span><span>{num(Math.round(calc.atendidas0))}</span></li>
          <li><span>Atendidas al mes con los cambios</span><span>{num(Math.round(calc.atendidas1))}</span></li>
          <li><span>Asistencia resultante</span><span>{tasaTxt(calc.a1, 1)}</span></li>
          <li><span>Citas que no ocurren</span><span>{tasaTxt(calc.nc1, 0)}</span></li>
          <li><span>Cupos recolocados por la lista</span><span>{num(Math.round(calc.recolocadas))} de {num(Math.round(calc.liberadas1))}</span></li>
        </ul>
        <p className="nota">Supuestos: la demanda y la duración de las citas no cambian, y cada cupo recolocado se atiende con la asistencia resultante. No incluye nuevos pacientes.</p>
      </Tarjeta>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- página
type Vista = 'prediccion' | 'abandono' | 'anomalias' | 'simulador';

const FUNCION: Record<Vista, [string, string]> = {
  prediccion: ['inteligencia.prediccion', 'Predicción de inasistencia'],
  abandono: ['inteligencia.abandono', 'Pacientes que se alejan'],
  anomalias: ['inteligencia.anomalias', 'Días fuera de lo normal'],
  simulador: ['inteligencia.simulador', 'Simulador'],
};

export default function Inteligencia({ rango }: { rango: Rango }) {
  const { puede, visible } = useAcceso();
  // Cada rol ve sus pestañas; la primera que pueda usar abre por defecto.
  const vistas = (Object.keys(FUNCION) as Vista[]).filter((v) => visible(FUNCION[v][0]));
  const [vista, setVista] = usePestana<Vista>(vistas, vistas.find((v) => puede(FUNCION[v][0])) ?? vistas[0] ?? 'anomalias');
  const bloqueadas = vistas.filter((v) => !puede(FUNCION[v][0]));
  const NOMBRES: Record<Vista, string> = { prediccion: '¿Quién podría faltar?', abandono: '¿Quién se está alejando?', anomalias: '¿Qué días están fuera de lo normal?', simulador: '¿Qué pasaría si…?' };
  return (
    <>
      <Pestanas<Vista>
        bloqueadas={bloqueadas}
        opciones={vistas.map((v) => [v, NOMBRES[v]] as [Vista, string])}
        descripciones={{
          prediccion: 'Anticipe qué pacientes podrían no asistir para actuar antes de la cita.',
          abandono: 'Detecte pacientes cuya actividad está disminuyendo y priorice su seguimiento.',
          anomalias: 'Encuentre días que se comportan de forma distinta a lo habitual.',
          simulador: 'Explore cómo cambiarían los resultados si modifica algunos supuestos.',
        }}
        valor={vista}
        onCambio={setVista}
      />
      {bloqueadas.includes(vista) ? (
        <Bloqueado clave={FUNCION[vista][0]} titulo={FUNCION[vista][1]} alto={280} />
      ) : (
        <>
          {vista === 'prediccion' && <PrediccionInasistencia />}
          {vista === 'abandono' && <Abandono />}
          {vista === 'anomalias' && <Anomalias />}
          {vista === 'simulador' && <Simulador rango={rango} />}
        </>
      )}
    </>
  );
}
