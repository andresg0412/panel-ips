// Etapa 4 · "Mi agenda" (PRO-05): la semana del profesional que inicia sesión y los pacientes suyos que faltan con
// frecuencia. El servidor decide de qué profesional son los datos (vínculo en la consola de soporte); el rol soporte
// puede elegir cualquiera para revisar. Sin descargas: son datos de pacientes.
import { useCallback, useState } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas } from '../components/series';
import { Estado, Kpi, Tabla, Tarjeta, type Columna } from '../components/ui';
import { useAcceso } from '../acceso';
import { useMarcas } from '../incidentes';
import { DIAS, etiqueta, fecha, num, pct, ratio } from '../format';

interface Proxima {
  fecha_cita: string;
  hora: string;
  nombre_paciente: string | null;
  tipo_servicio: string;
  modalidad: string;
  estado_agenda: string;
  faltas_recientes: number;
}
interface Falta {
  paciente: string | null;
  faltas: number;
  atendidas: number;
  ultima_falta: string | null;
  proxima: string | null;
}
interface Datos {
  vinculado: boolean;
  nombre: string | null;
  kpis?: { total: number; asistio: number; no_asistio: number; no_ocurrieron: number; sin_cierre: number; pacientes: number };
  proximas?: Proxima[];
  faltan?: Falta[];
  mensual?: { mes: string; asistio: number; no_asistio: number; no_ocurrieron: number }[];
  ocupacion?: { cupos: number | null; ocupan: number | null };
  libres?: { fecha: string; cupos: number; libres: number; primera_libre: string | null }[];
}

const diaTxt = (f: string) => `${DIAS[((new Date(`${f}T12:00:00Z`).getUTCDay() + 6) % 7) + 1]} ${fecha(f)}`;

const COLS_PROX: Columna<Proxima>[] = [
  { clave: 'fecha_cita', titulo: 'Día', formato: (v) => diaTxt(v) },
  { clave: 'hora', titulo: 'Hora' },
  { clave: 'nombre_paciente', titulo: 'Paciente' },
  { clave: 'tipo_servicio', titulo: 'Atención', formato: etiqueta },
  { clave: 'modalidad', titulo: 'Modalidad', formato: etiqueta },
  {
    clave: 'estado_agenda',
    titulo: 'Confirmación',
    formato: (v) => (v === 'Confirmado' ? <span style={{ color: 'var(--up)' }}>Confirmó</span> : <span style={{ color: 'var(--muted)' }}>Sin confirmar</span>),
  },
  {
    clave: 'faltas_recientes',
    titulo: 'Faltas en 6 meses',
    num: true,
    formato: (v) => (v >= 2 ? <b style={{ color: 'var(--down)' }}>{num(v)}</b> : v ? num(v) : '—'),
  },
];

const COLS_FALTAN: Columna<Falta>[] = [
  { clave: 'paciente', titulo: 'Paciente' },
  { clave: 'faltas', titulo: 'Faltas (120 días)', num: true },
  { clave: 'atendidas', titulo: 'Atendidas', num: true },
  { clave: 'ultima_falta', titulo: 'Última falta', formato: (v) => (v ? fecha(v) : '—') },
  { clave: 'proxima', titulo: 'Próxima cita', formato: (v) => (v ? diaTxt(v) : 'Sin cita') },
];

function Agenda({ datos, rango }: { datos: Datos; rango: Rango }) {
  const marcas = useMarcas(rango, ['agenda']);
  const optMensual = useCallback(() => {
    const m = datos.mensual ?? [];
    return barrasApiladas(
      m.map((x) => x.mes),
      { 'Asistió': m.map((x) => x.asistio), 'No asistió': m.map((x) => x.no_asistio), 'Cancelada o reprogramada': m.map((x) => x.no_ocurrieron) },
      'month',
    );
  }, [datos]);
  const k = datos.kpis!;
  const oc = datos.ocupacion;
  const libres = datos.libres ?? [];
  const totalLibres = libres.reduce((s, x) => s + x.libres, 0);
  const proximas = datos.proximas ?? [];
  const sinConfirmar = proximas.filter((p) => p.estado_agenda !== 'Confirmado').length;
  const riesgo = proximas.filter((p) => p.faltas_recientes >= 2).length;

  return (
    <>
      <h3 style={{ margin: '0 0 12px' }}>{datos.nombre}</h3>
      <div className="kpis">
        <Kpi etiqueta="Citas atendidas" actual={k.asistio} />
        <Kpi etiqueta="Asistencia" formato="pct" actual={ratio(k.asistio, k.asistio + k.no_asistio)} ayuda="Asistió ÷ (asistió + no asistió) en el período." />
        <Kpi etiqueta="Canceladas o reprogramadas" valor={pct(k.no_ocurrieron, k.total)} actual={null} />
        <Kpi etiqueta="Pacientes atendidos" actual={k.pacientes} />
        {oc?.cupos ? (
          <Kpi etiqueta="Ocupación de su horario" valor={pct(oc.ocupan ?? 0, oc.cupos, 0)} actual={null} ayuda="Cupos de su horario ocupados por citas, en los días ya pasados del período." />
        ) : null}
      </div>
      <Tarjeta
        titulo="Mis próximas citas"
        marcas={marcas}
        ayuda={`Próximos 14 días: ${num(proximas.length)} citas, ${num(sinConfirmar)} sin confirmar${riesgo ? ` y ${num(riesgo)} con pacientes que faltaron 2 o más veces en los últimos 6 meses (conviene reforzar el recordatorio)` : ''}.`}
      >
        <Tabla filas={proximas} columnas={COLS_PROX} vacio="Sin citas programadas en los próximos 14 días" />
      </Tarjeta>
      <div className="grid g2">
        <Tarjeta titulo="Pacientes que faltan con frecuencia" ayuda="Sus pacientes con 2 o más inasistencias en los últimos 120 días. Una llamada antes de la próxima cita ayuda a que no se pierda.">
          <Tabla filas={datos.faltan ?? []} columnas={COLS_FALTAN} vacio="Ningún paciente suyo faltó 2 o más veces en los últimos 120 días" />
        </Tarjeta>
        <Tarjeta
          titulo="Mis cupos libres"
          marcas={[{ tipo: 'estimada', detalle: 'Según el horario registrado en el sistema. Conviene confirmarlo con recepción.' }]}
          ayuda={libres.length ? `${num(totalLibres)} cupos sin cita en los próximos 14 días, según su horario.` : 'Su horario no está registrado en el sistema, o no tiene citas enlazadas a su ficha.'}
        >
          {libres.length > 0 && (
            <ul className="lista-simple">
              {libres.filter((l) => l.libres > 0).map((l) => (
                <li key={l.fecha}>
                  <span>
                    {diaTxt(l.fecha)} <span className="nota">· desde las {l.primera_libre}</span>
                  </span>
                  <span>{num(l.libres)} de {num(l.cupos)}</span>
                </li>
              ))}
            </ul>
          )}
        </Tarjeta>
      </div>
      <Tarjeta titulo="Mis citas por mes" ayuda="Últimos 12 meses, sin importar el período elegido.">
        <Grafico opcion={optMensual} alto={240} />
      </Tarjeta>
    </>
  );
}

export default function MiAgenda({ rango }: { rango: Rango }) {
  const { yo } = useAcceso();
  const esSoporte = yo?.rolReal === 'soporte' && !yo.vistaPrevia;
  const [elegido, setElegido] = useState('');
  const lista = useApi<{ filas: { nombre: string; especialidad: string | null; citas_90d: number }[] }>(esSoporte ? '/api/soporte/profesionales' : null);
  const url = esSoporte ? (elegido ? conRango('/api/mi-agenda', rango, { profesional: elegido }) : null) : conRango('/api/mi-agenda', rango);
  const { data, error, cargando } = useApi<Datos>(url, 120_000);

  return (
    <>
      {esSoporte && (
        <Tarjeta titulo="Ver la agenda de un profesional" ayuda="Solo soporte puede elegir. Cada usuario profesional ve únicamente la suya (se vincula en la consola de soporte, Usuarios y roles).">
          <select className="boton" value={elegido} onChange={(e) => setElegido(e.target.value)}>
            <option value="">Elija un profesional…</option>
            {(lista.data?.filas ?? []).map((p) => (
              <option key={p.nombre} value={p.nombre}>
                {p.nombre}
                {p.especialidad ? ` · ${p.especialidad}` : ''}
              </option>
            ))}
          </select>
        </Tarjeta>
      )}
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && !data.vinculado && !esSoporte && (
        <Tarjeta titulo="Mi agenda">
          <p className="vacio">Su usuario todavía no está vinculado a su nombre en la agenda. Pida a soporte que lo vincule para ver sus citas y sus pacientes.</p>
        </Tarjeta>
      )}
      {data?.vinculado && <Agenda datos={data} rango={rango} />}
    </>
  );
}
