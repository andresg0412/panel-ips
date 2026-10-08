import { useCallback } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, embudo, pivotar } from '../components/series';
import { Estado, Kpi, ListaConteo, Tabla, Tarjeta, type Columna } from '../components/ui';
import { etiqueta, fecha, fechaHora, hora, num } from '../format';
import { Bloqueado, Restringido, useAcceso } from '../acceso';

type Conteo = { clave: string; n: number };
interface Cupo {
  detectado: string;
  fecha_cita: string;
  hora_cita: string;
  estado: string;
  profesional: string | null;
  especialidad: string | null;
  asignado_a: string | null;
  motivo_cierre: string | null;
}
interface Oferta {
  enviada: string | null;
  respondida: string | null;
  estado: string;
  paciente: string | null;
  fecha_cita: string | null;
  hora_cita: string | null;
  profesional: string | null;
  posicion_en_fila: number | null;
}
interface Ejecucion {
  iniciada: string;
  campana_tipo: string;
  estado: string;
  total_evaluadas: number;
  total_elegibles: number;
  enviadas: number;
  errores: number;
  motivo_fin: string | null;
}
interface Ahora {
  activas: number;
  con_oferta_en_curso: number;
  esperando_cupo: number;
  sin_cita_elegible: number;
  pausadas: number;
  cupos_en_espera: number;
}
interface Respuesta {
  ofertas: number;
  con_toque: number;
  aceptaciones_perdidas: number;
  minutos_a_leer: number | null;
  minutos_a_responder: number | null;
}
interface Datos {
  ahora: Ahora;
  pausadas: Conteo[];
  flujoPeriodo: Conteo[];
  flujoDiario: { dia: string; clave: string; n: number }[];
  respuesta: Respuesta;
  inscripcionesHoy: Conteo[];
  inscripciones: Conteo[];
  cupos: Conteo[];
  ofertas: Conteo[];
  invitaciones: Conteo[];
  cuposRecientes: Cupo[];
  ofertasRecientes: Oferta[];
  ejecuciones: Ejecucion[];
  embudo: {
    cupos: number;
    con_oferta: number;
    aceptados: number;
    asignados: number;
    horas_recuperadas: number;
    minutos_hasta_asignar: number | null;
    recolocadas_atendidas: number;
  };
  motivos: Conteo[];
  invitacionesPorTipo: { campana_tipo: string; clave: string; n: number }[];
}

const lista = (c: Conteo[]) => c.map((x) => ({ clave: x.clave, etiqueta: etiqueta(x.clave), n: x.n }));
const suma = (c: Conteo[]) => c.reduce((s, x) => s + x.n, 0);
const de = (c: Conteo[], clave: string) => c.find((x) => x.clave === clave)?.n ?? 0;
/** Minutos como texto corto: "45 min", "3 h". */
const minutosTxt = (m: number | null) => (m === null || m === undefined ? '—' : m < 90 ? `${num(m)} min` : `${num(Math.round(m / 6) / 10)} h`);
const FLUJO = ['inscritos', 'consiguieron_cupo', 'salieron', 'reactivadas'];
const cita = (v: string | null, f: { hora_cita: string | null }) => (v ? `${fecha(v)} ${hora(f.hora_cita)}` : '—');

const COLS_CUPO: Columna<Cupo>[] = [
  { clave: 'detectado', titulo: 'Liberado', formato: fechaHora },
  { clave: 'fecha_cita', titulo: 'Cita disponible', formato: cita },
  { clave: 'profesional', titulo: 'Profesional' },
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'estado', titulo: 'Estado', formato: etiqueta, csv: etiqueta },
  { clave: 'asignado_a', titulo: 'Asignado a' },
];
const COLS_OFERTA: Columna<Oferta>[] = [
  { clave: 'enviada', titulo: 'Enviada', formato: fechaHora },
  { clave: 'paciente', titulo: 'Paciente' },
  { clave: 'fecha_cita', titulo: 'Cupo ofrecido', formato: cita },
  { clave: 'profesional', titulo: 'Profesional' },
  { clave: 'posicion_en_fila', titulo: 'Puesto en la fila', num: true },
  { clave: 'estado', titulo: 'Resultado', formato: etiqueta, csv: etiqueta },
  { clave: 'respondida', titulo: 'Respondió', formato: fechaHora },
];
const COLS_EJEC: Columna<Ejecucion>[] = [
  { clave: 'iniciada', titulo: 'Fecha', formato: fechaHora },
  { clave: 'campana_tipo', titulo: 'Tipo', formato: etiqueta, csv: etiqueta },
  { clave: 'total_evaluadas', titulo: 'Citas revisadas', num: true },
  { clave: 'total_elegibles', titulo: 'Elegibles', num: true },
  { clave: 'enviadas', titulo: 'Invitaciones enviadas', num: true },
  { clave: 'errores', titulo: 'Errores', num: true },
  { clave: 'estado', titulo: 'Estado', formato: etiqueta, csv: etiqueta },
];

export default function ListaEspera({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Datos>(conRango('/api/lista-espera', rango), 60_000);
  const { puede } = useAcceso();
  const detalle = puede('listaEspera.detalle');
  const invitaciones = puede('listaEspera.invitaciones');

  const optEmbudo = useCallback(() => {
    const e = data!.embudo;
    return embudo([
      { nombre: 'Cupos liberados por cancelación', valor: e.cupos },
      { nombre: 'Se ofrecieron a la lista', valor: e.con_oferta },
      { nombre: 'Un paciente aceptó', valor: e.aceptados },
      { nombre: 'Cupo asignado', valor: e.asignados },
      { nombre: 'El paciente asistió', valor: e.recolocadas_atendidas },
    ]);
  }, [data]);

  const optFlujo = useCallback(() => {
    const filas = data!.flujoDiario.map((f) => ({ periodo: f.dia, grupo: etiqueta(f.clave), n: f.n }));
    const { periodos, series } = pivotar(filas, 'grupo', 'n', FLUJO.map(etiqueta));
    return barrasApiladas(periodos, series, 'day');
  }, [data]);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tarjeta
            titulo="En lista de espera ahora"
            ayuda="Foto de este momento (no depende del período elegido). Activa = inscripción vigente; esperando cupo = su cita sigue vigente y no tiene una oferta en curso."
          >
            <div className="cifras">
              <div className="cifra"><div className="n">{num(data.ahora.activas)}</div><div className="t">inscripciones activas</div></div>
              <div className="cifra"><div className="n">{num(data.ahora.esperando_cupo)}</div><div className="t">esperando un cupo</div></div>
              <div className="cifra"><div className="n">{num(data.ahora.con_oferta_en_curso)}</div><div className="t">con una oferta en curso</div></div>
              <div className="cifra"><div className="n">{num(data.ahora.sin_cita_elegible)}</div><div className="t">sin cita vigente (no reciben ofertas)</div></div>
              <div className="cifra"><div className="n">{num(data.ahora.pausadas)}</div><div className="t">pausadas</div></div>
              <div className="cifra"><div className="n">{num(data.ahora.cupos_en_espera)}</div><div className="t">cupos esperando candidatos</div></div>
            </div>
            {data.pausadas.length > 0 && (
              <>
                <p className="ayuda" style={{ marginTop: 12 }}>Pausadas, por motivo:</p>
                <ListaConteo items={lista(data.pausadas)} total={suma(data.pausadas)} />
              </>
            )}
            <div className="cifras" style={{ marginTop: 12 }}>
              {FLUJO.map((k) => (
                <div className="cifra" key={k}><div className="n">{num(de(data.flujoPeriodo, k))}</div><div className="t">{etiqueta(k).toLowerCase()} (período)</div></div>
              ))}
            </div>
            {data.flujoDiario.length > 0 && <Grafico opcion={optFlujo} alto={220} />}
          </Tarjeta>
          <div className="kpis">
            {detalle && (
              <>
                <Kpi etiqueta="Nuevas inscripciones" actual={suma(data.inscripciones)} />
                <Kpi etiqueta="Cupos liberados" actual={suma(data.cupos)} />
                <Kpi etiqueta="Ofertas enviadas" actual={suma(data.ofertas)} />
                <Kpi etiqueta="Ofertas aceptadas" actual={de(data.ofertas, 'aceptada')} />
              </>
            )}
            {invitaciones && <Kpi etiqueta="Invitaciones a inscribirse" actual={suma(data.invitaciones)} />}
          </div>
          {!detalle && <Bloqueado clave="listaEspera.detalle" titulo="Cupos recuperados, ofertas y motivos" alto={260} />}
          {detalle && (
          <>
          <div className="grid g2">
            <Tarjeta
              titulo="De cupo liberado a cita atendida"
              ayuda={`Cuando una cita se cancela, el sistema ofrece ese cupo a pacientes inscritos con una cita más lejana (funciona desde el 30 sep 2026). ${data.embudo.cupos < 20 ? 'Con tan pocos cupos, los porcentajes todavía no son representativos.' : 'Porcentaje de cada etapa sobre la anterior.'}`}
            >
              {data.embudo.cupos ? <Grafico opcion={optEmbudo} alto={230} /> : <p className="ayuda">Sin cupos liberados en este período.</p>}
            </Tarjeta>
            <Tarjeta titulo="Lo que recuperó la lista" ayuda="Horas de consulta que, sin la lista, habrían quedado vacías.">
              <div className="cifras">
                <div className="cifra"><div className="n">{num(data.embudo.horas_recuperadas)} h</div><div className="t">de consulta recuperadas</div></div>
                <div className="cifra"><div className="n">{data.embudo.cupos ? `${Math.round((data.embudo.asignados / data.embudo.cupos) * 100)} %` : '—'}</div><div className="t">de los cupos liberados se recolocaron</div></div>
                <div className="cifra"><div className="n">{data.embudo.minutos_hasta_asignar === null ? '—' : data.embudo.minutos_hasta_asignar < 60 ? `${data.embudo.minutos_hasta_asignar} min` : `${Math.round(data.embudo.minutos_hasta_asignar / 60)} h`}</div><div className="t">tiempo típico hasta recolocar</div></div>
              </div>
              {data.motivos.length > 0 && (
                <>
                  <p className="ayuda" style={{ marginTop: 12 }}>Cupos que no se recolocaron, por motivo:</p>
                  <ListaConteo items={lista(data.motivos)} total={suma(data.motivos)} />
                </>
              )}
            </Tarjeta>
          </div>
          <Tarjeta
            titulo="Qué tan bien responden los pacientes a las ofertas"
            ayuda="Toque = el paciente tocó un botón de la oferta. Aceptación perdida = tocó «Sí» cuando la oferta ya había vencido. Los tiempos son la mediana del período."
          >
            <div className="cifras">
              <div className="cifra"><div className="n">{data.respuesta.ofertas ? `${Math.round((data.respuesta.con_toque / data.respuesta.ofertas) * 100)} %` : '—'}</div><div className="t">de las ofertas recibió un toque ({num(data.respuesta.con_toque)} de {num(data.respuesta.ofertas)})</div></div>
              <div className="cifra"><div className="n">{num(data.respuesta.aceptaciones_perdidas)}</div><div className="t">aceptaciones perdidas por plazo</div></div>
              <div className="cifra"><div className="n">{minutosTxt(data.respuesta.minutos_a_leer)}</div><div className="t">hasta leer la oferta</div></div>
              <div className="cifra"><div className="n">{minutosTxt(data.respuesta.minutos_a_responder)}</div><div className="t">hasta responder</div></div>
            </div>
          </Tarjeta>
          <div className="grid g3">
            <Tarjeta titulo="Inscripciones del período" ayuda="Estado actual de cada inscripción.">
              <ListaConteo items={lista(data.inscripciones)} total={suma(data.inscripciones)} />
            </Tarjeta>
            <Tarjeta titulo="Cupos liberados" ayuda="Qué pasó con cada cupo que dejó una cancelación.">
              <ListaConteo items={lista(data.cupos)} total={suma(data.cupos)} />
            </Tarjeta>
            <Tarjeta titulo="Ofertas de cupo" ayuda="Respuesta de los pacientes a las ofertas.">
              <ListaConteo items={lista(data.ofertas)} total={suma(data.ofertas)} />
            </Tarjeta>
          </div>
          <Tarjeta titulo="Cupos liberados recientes">
            <Tabla filas={data.cuposRecientes} columnas={COLS_CUPO} nombreCsv="cupos_liberados" />
          </Tarjeta>
          <Tarjeta titulo="Ofertas recientes">
            <Tabla filas={data.ofertasRecientes} columnas={COLS_OFERTA} nombreCsv="ofertas_cupo" />
          </Tarjeta>
          </>
          )}
          <Restringido clave="listaEspera.invitaciones" titulo="Campañas de invitación a la lista de espera">
          <Tarjeta titulo="Invitaciones a la lista de espera" ayuda="Respuesta de los pacientes invitados a inscribirse, por tipo de campaña.">
            {data.invitacionesPorTipo.length ? (
              <ListaConteo
                items={data.invitacionesPorTipo.map((i) => ({ clave: `${i.campana_tipo}-${i.clave}`, etiqueta: `${etiqueta(i.campana_tipo)}: ${etiqueta(i.clave)}`, n: i.n }))}
                total={data.invitacionesPorTipo.reduce((s, i) => s + i.n, 0)}
              />
            ) : (
              <p className="ayuda">Sin datos aún: aparecerán cuando se active la campaña de invitación a la lista de espera.</p>
            )}
          </Tarjeta>
          <Tarjeta titulo="Ejecuciones de la campaña de invitación" ayuda="Envíos que invitan a pacientes con citas lejanas a inscribirse en la lista de espera.">
            <Tabla filas={data.ejecuciones} columnas={COLS_EJEC} nombreCsv="invitaciones" vacio="Aún no se han ejecutado campañas de invitación en este período" />
          </Tarjeta>
          </Restringido>
        </>
      )}
    </>
  );
}
