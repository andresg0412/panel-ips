// Etapa 4 · Centro de capacidad (grupo Operación): dónde sobra y dónde falta agenda. Reúne lo que estaba repartido
// entre Agenda, Profesionales y Lista de espera, con enfoque de planificación (nunca como ranking de personas).
import { useCallback, useMemo } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, barrasTasa, mapaCalor } from '../components/series';
import { Estado, Tabla, Tarjeta, type Columna, type MarcaDato } from '../components/ui';
import { Bloqueado, useAcceso } from '../acceso';
import { Pestanas, useMarcas, usePestana, useSombras } from '../incidentes';
import { AgendaInasistencia } from './AgendaAnalisis';
import { AgendaProximas, AnticipacionCancelaciones } from './Ocupacion';
import { DIAS, etiqueta, fecha, num, pct, tasaTxt } from '../format';

const CAPACIDAD: MarcaDato = {
  tipo: 'estimada',
  detalle: 'La capacidad sale del horario vigente de cada profesional (no hay historial de horarios) y no descuenta ausencias ni festivos que falten en el sistema. Solo profesionales con horario registrado y citas enlazadas a su ficha.',
};

const fechaHoraTxt = (v: string | null) => (v ? `${fecha(v.slice(0, 10))} ${v.slice(11, 16)}` : '—');
const diasTxt = (d: number | null) => (d === null ? 'Sin cupos libres en 30 días' : d === 0 ? 'Hoy' : d === 1 ? 'Mañana' : `En ${d} días`);

// ------------------------------------------------------------------------------------------ ocupación
interface Fila {
  profesional: string;
  especialidad: string | null;
  cupos: number;
  ocupan: number;
  libres: number;
  liberadas: number;
  administrativas: number;
}
interface Centro {
  desde: string;
  hasta: string;
  hoy: string;
  medible: boolean;
  capacidadDesde: string;
  profesionales: Fila[];
  especialidades: (Omit<Fila, 'profesional'> & { especialidad: string })[];
  franjas: { dia: number; hora: number; ofrecidos: number; libres: number }[];
  futuro: { profesional: string; especialidad: string | null; primera: string | null; dias: number | null; libres_7d: number; libres_14d: number; cupos_14d: number }[];
  espera: { especialidad: string; primera: string | null; dias: number | null; libres_7d: number; libres_14d: number; cupos_14d: number; profesionales: number }[];
}

/** Celdas día × hora con menos cupos que esto se muestran sin valor (pocos datos). */
const MIN_CUPOS = 8;

function Ocupacion({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Centro>(conRango('/api/capacidad', rango), 300_000);
  const marcas = useMarcas(rango, ['agenda'], data?.capacidadDesde);
  const tot = useMemo(() => {
    const f = data?.profesionales ?? [];
    const s = (k: keyof Fila) => f.reduce((a, x) => a + Number(x[k] ?? 0), 0);
    return { cupos: s('cupos'), ocupan: s('ocupan'), libres: s('libres'), liberadas: s('liberadas'), administrativas: s('administrativas') };
  }, [data]);

  const optEsp = useCallback(
    () => barrasTasa(data!.especialidades.map((e) => ({ nombre: e.especialidad, parte: e.ocupan, total: e.cupos })), 1, tot.cupos ? tot.ocupan / tot.cupos : undefined),
    [data, tot],
  );
  // Por nombre, no por ocupación: es planificación de capacidad, no un ranking.
  const optProf = useCallback(
    () =>
      barrasTasa(
        [...data!.profesionales].sort((a, b) => a.profesional.localeCompare(b.profesional)).map((p) => ({ nombre: p.profesional, parte: p.ocupan, total: p.cupos })),
        1,
        tot.cupos ? tot.ocupan / tot.cupos : undefined,
      ),
    [data, tot],
  );
  const optFranjas = useCallback(() => {
    const f = data!.franjas;
    const horas = [...new Set(f.map((c) => c.hora))].sort((a, b) => a - b);
    const dias = [6, 5, 4, 3, 2, 1].filter((d) => f.some((c) => c.dia === d));
    const celdas: [number, number, number | null, number][] = f
      .filter((c) => dias.includes(c.dia))
      .map((c) => [horas.indexOf(c.hora), dias.indexOf(c.dia), c.ofrecidos >= MIN_CUPOS ? c.libres / c.ofrecidos : null, c.ofrecidos]);
    return mapaCalor(horas.map((h) => `${h}:00`), dias.map((d) => DIAS[d]), celdas, (v) => tasaTxt(v, 0), (x, y, v, n) =>
      v === null ? `${y} ${x}: pocos cupos (${num(n)})` : `${y} ${x}: <b>${tasaTxt(v, 0)}</b> de los cupos quedó sin usar (${num(n)} cupos)`,
    );
  }, [data]);

  const peores = useMemo(
    () =>
      (data?.franjas ?? [])
        .filter((c) => c.ofrecidos >= MIN_CUPOS && c.dia <= 6)
        .map((c) => ({ ...c, tasa: c.libres / c.ofrecidos }))
        .sort((a, b) => b.tasa - a.tasa)
        .slice(0, 3),
    [data],
  );

  if (error || (cargando && !data)) return <Estado cargando={cargando} error={error} hayDatos={!!data} />;
  if (!data) return null;
  if (!data.medible) {
    return (
      <Tarjeta titulo="¿Qué tan llena estuvo la agenda?">
        <p className="vacio">
          La ocupación se mide sobre días ya pasados, desde el {fecha(data.capacidadDesde)}. Elija un período que incluya días anteriores a hoy; la espera y los cupos libres de los próximos
          días están en la pestaña «Próximas semanas y espera».
        </p>
      </Tarjeta>
    );
  }
  return (
    <>
      <Tarjeta
        titulo="¿Qué tan llena estuvo la agenda?"
        marcas={[CAPACIDAD, ...marcas]}
        ayuda={`Cupos del horario de cada profesional frente a las citas que los ocuparon, del ${fecha(data.desde)} al ${fecha(data.hasta)} (días ya pasados).`}
      >
        <div className="cifras">
          <div className="cifra">
            <div className="n">{pct(tot.ocupan, tot.cupos, 0)}</div>
            <div className="t">de ocupación ({num(tot.ocupan)} de {num(tot.cupos)} cupos)</div>
          </div>
          <div className="cifra">
            <div className="n">{num(tot.libres)}</div>
            <div className="t">cupos quedaron sin usar ({pct(tot.libres, tot.cupos, 0)})</div>
          </div>
          <div className="cifra">
            <div className="n">{num(tot.liberadas)}</div>
            <div className="t">citas canceladas o reprogramadas liberaron cupo</div>
          </div>
          {tot.administrativas > 0 && (
            <div className="cifra">
              <div className="n">{num(tot.administrativas)}</div>
              <div className="t">cupos usados en reuniones internas</div>
            </div>
          )}
        </div>
      </Tarjeta>
      <div className="grid g2">
        <Tarjeta titulo="Ocupación por especialidad" ayuda="La línea punteada es el promedio de toda la agenda medible.">
          <Grafico opcion={optEsp} alto={Math.max(110, data.especialidades.length * 46 + 40)} />
        </Tarjeta>
        <Tarjeta titulo="Ocupación por profesional" ayuda="Para planear la agenda, no para comparar personas: depende de su horario, sus pacientes y sus convenios.">
          <Grafico opcion={optProf} alto={Math.max(200, data.profesionales.length * 34 + 40)} />
        </Tarjeta>
      </div>
      <Tarjeta
        titulo="¿Cuándo sobra capacidad?"
        marcas={[CAPACIDAD]}
        ayuda={`Porcentaje de cupos que quedó sin cita, por día de la semana y hora (la escala de color está debajo; pase el cursor para ver el valor). Celdas con menos de ${MIN_CUPOS} cupos, sin valor.`}
      >
        {peores.length > 0 && (
          <p className="frase">
            Más cupos sin usar: <b>{peores.map((c) => `${DIAS[c.dia].toLowerCase()} ${c.hora}:00 (${tasaTxt(c.tasa, 0)})`).join(', ')}</b>. Son buenas franjas para ofrecer citas o
            mover horarios.
          </p>
        )}
        <Grafico opcion={optFranjas} alto={300} />
      </Tarjeta>
      {data.profesionales.length === 0 && <p className="vacio">Sin profesionales con horario medible en el período.</p>}
    </>
  );
}

// ------------------------------------------------------------------------------- espera y próximas semanas
const COLS_ESPERA: Columna<Centro['espera'][number]>[] = [
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'dias', titulo: 'Primera cita disponible', formato: (v) => diasTxt(v), orden: (f) => f.dias ?? 999 },
  { clave: 'primera', titulo: 'Fecha y hora', formato: fechaHoraTxt },
  { clave: 'libres_7d', titulo: 'Cupos libres 7 días', num: true },
  { clave: 'libres_14d', titulo: 'Cupos libres 14 días', num: true },
  { clave: 'cupos_14d', titulo: '% libre a 14 días', num: true, formato: (v, f) => pct(f.libres_14d, v, 0), orden: (f) => (f.cupos_14d ? f.libres_14d / f.cupos_14d : 0) },
];
const COLS_FUTURO: Columna<Centro['futuro'][number]>[] = [
  { clave: 'profesional', titulo: 'Profesional' },
  { clave: 'dias', titulo: 'Primera hora libre', formato: (v) => diasTxt(v), orden: (f) => f.dias ?? 999 },
  { clave: 'primera', titulo: 'Fecha y hora', formato: fechaHoraTxt },
  { clave: 'libres_7d', titulo: 'Libres 7 días', num: true },
  { clave: 'libres_14d', titulo: 'Libres 14 días', num: true },
];

function Espera({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Centro>(conRango('/api/capacidad', rango), 300_000);
  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} forma="bloque" />
      {data && (
        <>
          <Tarjeta
            titulo="¿Cuánto espera hoy un paciente?"
            marcas={[CAPACIDAD]}
            ayuda="Primera hora del horario que sigue sin cita, desde este momento. Psiquiatría y neuropsicología no aparecen mientras sus profesionales no estén enlazados en el maestro de equipo."
          >
            <Tabla filas={data.espera} columnas={COLS_ESPERA} vacio="Sin profesionales con horario medible" />
          </Tarjeta>
          <Tarjeta titulo="Primera hora libre por profesional" marcas={[CAPACIDAD]} ayuda="Sirve para ofrecer citas por teléfono o desde la lista de espera. Conviene validarlo con recepción.">
            <Tabla filas={data.futuro} columnas={COLS_FUTURO} vacio="Sin profesionales con horario medible" />
          </Tarjeta>
        </>
      )}
      <AgendaProximas />
    </>
  );
}

// -------------------------------------------------------------------------------------- cancelaciones
interface Cancelaciones {
  rango: { grano: string };
  kpis: { total: number; canceladas: number; reprogramadas: number; horas: number };
  recolocados: number;
  profesionales: { profesional: string; especialidad: string | null; total: number; canceladas: number; reprogramadas: number; horas: number }[];
  especialidades: { especialidad: string; total: number; canceladas: number; reprogramadas: number }[];
  serie: { periodo: string; canceladas: number; reprogramadas: number }[];
}

const COLS_CANC: Columna<Cancelaciones['profesionales'][number]>[] = [
  { clave: 'profesional', titulo: 'Profesional' },
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'total', titulo: 'Citas', num: true },
  { clave: 'canceladas', titulo: 'Canceladas', num: true },
  { clave: 'reprogramadas', titulo: 'Reprogramadas', num: true },
  {
    clave: 'horas',
    titulo: 'Horas liberadas',
    num: true,
    formato: (v) => String(v).replace('.', ','),
  },
  {
    clave: 'total',
    titulo: 'No ocurrieron',
    num: true,
    formato: (_v, f) => pct(f.canceladas + f.reprogramadas, f.total, 0),
    csv: (_v, f) => pct(f.canceladas + f.reprogramadas, f.total, 0),
    orden: (f) => (f.total ? (f.canceladas + f.reprogramadas) / f.total : 0),
  },
];

function CancelacionesCapacidad({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Cancelaciones>(conRango('/api/capacidad/cancelaciones', rango), 120_000);
  const marcas = useMarcas(rango, ['agenda']);
  const sombras = useSombras(['agenda']);
  const optSerie = useCallback(
    () =>
      barrasApiladas(
        data!.serie.map((s) => s.periodo),
        { Cancelada: data!.serie.map((s) => s.canceladas), Reprogramada: data!.serie.map((s) => s.reprogramadas) },
        data!.rango.grano,
        sombras,
      ),
    [data, sombras],
  );
  const optEsp = useCallback(
    () =>
      barrasTasa(
        data!.especialidades.filter((e) => e.especialidad !== 'Sin especialidad').map((e) => ({ nombre: e.especialidad, parte: e.canceladas + e.reprogramadas, total: e.total })),
        30,
        data!.kpis.total ? (data!.kpis.canceladas + data!.kpis.reprogramadas) / data!.kpis.total : undefined,
      ),
    [data],
  );
  const k = data?.kpis;
  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && k && (
        <>
          <Tarjeta titulo="¿Cuántos cupos se pierden por cancelaciones?" marcas={marcas} ayuda="Citas de pacientes del período que no ocurrieron porque se cancelaron o se movieron a otra fecha.">
            <div className="cifras">
              <div className="cifra">
                <div className="n">{pct(k.canceladas + k.reprogramadas, k.total, 0)}</div>
                <div className="t">de las citas no ocurrió ({num(k.canceladas)} canceladas y {num(k.reprogramadas)} reprogramadas)</div>
              </div>
              <div className="cifra">
                <div className="n">{num(Math.round(k.horas))}</div>
                <div className="t">horas de consulta liberadas</div>
              </div>
              <div className="cifra">
                <div className="n">{num(data.recolocados)}</div>
                <div className="t">cupos recolocados por la lista de espera</div>
              </div>
            </div>
            <Grafico opcion={optSerie} alto={240} />
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Por especialidad" ayuda="Porcentaje de citas que no ocurrieron. La línea punteada es el promedio.">
              <Grafico opcion={optEsp} alto={Math.max(160, data.especialidades.length * 46 + 40)} />
            </Tarjeta>
            <AnticipacionCancelaciones rango={rango} />
          </div>
          <Tarjeta titulo="Por profesional" ayuda="Para planear la agenda: estas cifras dependen de los pacientes y convenios de cada profesional.">
            <Tabla filas={data.profesionales} columnas={COLS_CANC} nombreCsv="cancelaciones_por_profesional" />
          </Tarjeta>
        </>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------------------- modalidad
interface Modalidad {
  rango: { grano: string };
  modalidades: { modalidad: string; total: number; asistio: number; no_asistio: number; no_ocurrieron: number; programadas: number }[];
  especialidades: { especialidad: string; presencial: number; virtual: number }[];
  serie: { periodo: string; presencial: number; virtual: number }[];
}

function ModalidadCapacidad({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Modalidad>(conRango('/api/capacidad/modalidad', rango), 120_000);
  const marcas = useMarcas(rango, ['agenda']);
  const sombras = useSombras(['agenda']);
  const optSerie = useCallback(
    () =>
      barrasApiladas(
        data!.serie.map((s) => s.periodo),
        { Presencial: data!.serie.map((s) => s.presencial), Virtual: data!.serie.map((s) => s.virtual) },
        data!.rango.grano,
        sombras,
      ),
    [data, sombras],
  );
  const optEsp = useCallback(
    () =>
      barrasTasa(
        data!.especialidades.filter((e) => e.presencial + e.virtual > 0).map((e) => ({ nombre: e.especialidad, parte: e.virtual, total: e.presencial + e.virtual })),
        20,
      ),
    [data],
  );
  const m = (k: string) => data?.modalidades.find((x) => x.modalidad === k);
  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tarjeta titulo="Presencial o virtual" marcas={marcas} ayuda="Citas de pacientes del período según su modalidad. Asistencia = asistió ÷ (asistió + no asistió).">
            <div className="grid g2" style={{ gap: 12 }}>
              {['presencial', 'virtual'].map((k) => {
                const x = m(k);
                return (
                  <div key={k}>
                    <h4 style={{ margin: '0 0 6px' }}>{etiqueta(k)}</h4>
                    {x ? (
                      <ul className="lista-simple">
                        <li><span>Citas</span><span>{num(x.total)}</span></li>
                        <li><span>Atendidas</span><span>{num(x.asistio)}</span></li>
                        <li><span>Asistencia</span><span>{pct(x.asistio, x.asistio + x.no_asistio)}</span></li>
                        <li><span>No ocurrieron (canceladas o movidas)</span><span>{pct(x.no_ocurrieron, x.total)}</span></li>
                      </ul>
                    ) : (
                      <p className="vacio">Sin citas {k === 'virtual' ? 'virtuales' : 'presenciales'} en el período.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Atendidas por modalidad" ayuda="Citas atendidas en cada período.">
              <Grafico opcion={optSerie} alto={240} />
            </Tarjeta>
            <Tarjeta titulo="Peso de lo virtual por especialidad" ayuda="Porcentaje de las citas atendidas que fueron virtuales.">
              <Grafico opcion={optEsp} alto={Math.max(160, data.especialidades.length * 46 + 40)} />
            </Tarjeta>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------- recuperables
interface Recuperables {
  filas: { profesional: string; especialidad: string | null; liberados: number; horas: number; inscritos: number; recolocados: number; libres_14d: number }[];
}
const COLS_REC: Columna<Recuperables['filas'][number]>[] = [
  { clave: 'profesional', titulo: 'Profesional' },
  { clave: 'liberados', titulo: 'Cupos liberados (30 días)', num: true },
  { clave: 'recolocados', titulo: 'Recolocados por la lista', num: true },
  { clave: 'inscritos', titulo: 'Inscritos activos', num: true },
  { clave: 'libres_14d', titulo: 'Cupos libres (14 días)', num: true },
  {
    clave: 'inscritos',
    titulo: 'Recuperables ahora',
    num: true,
    formato: (_v, f) => num(Math.min(f.inscritos, f.libres_14d)),
    csv: (_v, f) => String(Math.min(f.inscritos, f.libres_14d)),
    orden: (f) => Math.min(f.inscritos, f.libres_14d),
  },
];

function RecuperablesCapacidad() {
  const { data, error, cargando } = useApi<Recuperables>('/api/capacidad/recuperables', 300_000);
  const t = useMemo(() => {
    const f = data?.filas ?? [];
    const s = (k: 'liberados' | 'horas' | 'inscritos' | 'recolocados' | 'libres_14d') => f.reduce((a, x) => a + Number(x[k]), 0);
    return { liberados: s('liberados'), horas: s('horas'), inscritos: s('inscritos'), recolocados: s('recolocados'), libres: s('libres_14d'), ahora: f.reduce((a, x) => a + Math.min(x.inscritos, x.libres_14d), 0) };
  }, [data]);
  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} forma="bloque" />
      {data && (
        <>
          <Tarjeta
            titulo="¿Cuántas citas se pueden recuperar?"
            marcas={[{ tipo: 'estimada', detalle: 'Recuperables ahora = el menor entre los inscritos activos de cada profesional y sus cupos libres de los próximos 14 días. Supone que el inscrito acepta el cupo.' }]}
            ayuda="Cupos que se liberaron en los últimos 30 días frente a los pacientes inscritos en la lista de espera de cada profesional. Sin inscritos, un cupo liberado no tiene a quién ofrecerse."
          >
            <div className="cifras">
              <div className="cifra">
                <div className="n">{num(t.liberados)}</div>
                <div className="t">cupos liberados en 30 días ({num(Math.round(t.horas))} horas de consulta)</div>
              </div>
              <div className="cifra">
                <div className="n">{num(t.recolocados)}</div>
                <div className="t">los recolocó la lista de espera</div>
              </div>
              <div className="cifra">
                <div className="n">{num(t.inscritos)}</div>
                <div className="t">pacientes inscritos esperando un cupo</div>
              </div>
              <div className="cifra">
                <div className="n">{num(t.ahora)}</div>
                <div className="t">citas recuperables ahora con los {num(t.libres)} cupos libres de los próximos 14 días</div>
              </div>
            </div>
            {t.inscritos === 0 && (
              <p className="nota">
                Hoy no hay pacientes inscritos en la lista de espera. Cuando el bot ofrezca la inscripción al agendar, esta tabla mostrará cuántos cupos se pueden llenar con ellos.
              </p>
            )}
          </Tarjeta>
          <Tarjeta titulo="Por profesional" ayuda="Las citas de psiquiatría y neuropsicología se agrupan por nombre porque sus profesionales no están enlazados en el maestro de equipo.">
            <Tabla filas={data.filas} columnas={COLS_REC} nombreCsv="citas_recuperables" vacio="Sin cupos liberados ni inscritos" />
          </Tarjeta>
        </>
      )}
    </>
  );
}

// -------------------------------------------------------------------------------------------- página
type Vista = 'ocupacion' | 'espera' | 'inasistencia' | 'cancelaciones' | 'modalidad' | 'recuperables';

const FUNCION: Record<Vista, [string, string]> = {
  ocupacion: ['capacidad.centro', 'Ocupación de la agenda'],
  espera: ['capacidad.centro', 'Próximas semanas y espera'],
  inasistencia: ['agenda.inasistencia', 'Inasistencia por día y hora'],
  cancelaciones: ['capacidad.cancelaciones', 'Cancelaciones y reprogramaciones'],
  modalidad: ['capacidad.modalidad', 'Presencial y virtual'],
  recuperables: ['capacidad.recuperables', 'Citas recuperables'],
};

export default function Capacidad({ rango }: { rango: Rango }) {
  const { puede } = useAcceso();
  const [vista, setVista] = usePestana<Vista>(
    ['ocupacion', 'espera', 'inasistencia', 'cancelaciones', 'modalidad', 'recuperables'],
    puede('capacidad.centro') ? 'ocupacion' : 'cancelaciones',
  );
  const bloqueadas = (Object.keys(FUNCION) as Vista[]).filter((v) => !puede(FUNCION[v][0]));
  return (
    <>
      <Pestanas<Vista>
        bloqueadas={bloqueadas}
        opciones={[
          ['ocupacion', '¿Cuánto usamos la agenda?'],
          ['espera', '¿Qué viene y cuánto esperamos?'],
          ['inasistencia', '¿Dónde están faltando?'],
          ['cancelaciones', '¿Qué se está cancelando?'],
          ['modalidad', '¿Cómo se usan las modalidades?'],
          ['recuperables', '¿Qué podemos recuperar?'],
        ]}
        descripciones={{
          ocupacion: 'Muestra qué porcentaje de los cupos disponibles fue utilizado.',
          espera: 'Ayuda a anticipar la demanda y la espera de los pacientes.',
          inasistencia: 'Identifique los días y horarios donde más pacientes dejan de asistir.',
          cancelaciones: 'Analice cancelaciones y reprogramaciones para recuperar capacidad.',
          modalidad: 'Compare el uso y el comportamiento de la atención presencial y virtual.',
          recuperables: 'Encuentre citas y cupos que todavía pueden convertirse en atención.',
        }}
        valor={vista}
        onCambio={setVista}
      />
      {bloqueadas.includes(vista) ? (
        <Bloqueado clave={FUNCION[vista][0]} titulo={FUNCION[vista][1]} alto={280} />
      ) : (
        <>
          {vista === 'ocupacion' && <Ocupacion rango={rango} />}
          {vista === 'espera' && <Espera rango={rango} />}
          {vista === 'inasistencia' && <AgendaInasistencia rango={rango} />}
          {vista === 'cancelaciones' && <CancelacionesCapacidad rango={rango} />}
          {vista === 'modalidad' && <ModalidadCapacidad rango={rango} />}
          {vista === 'recuperables' && <RecuperablesCapacidad />}
        </>
      )}
    </>
  );
}
