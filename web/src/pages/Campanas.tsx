import { useCallback, useMemo, useState } from 'react';
import { conRango, getJson, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, lineas, pivotar } from '../components/series';
import { Pestanas, usePestana, useSombras } from '../incidentes';
import CampanasEfecto, { CalendarioEjecuciones } from './CampanasEfecto';
import { descargarCsv, Estado, Tabla, Tarjeta, type Columna } from '../components/ui';
import { etiqueta, fecha, fechaHora, hora, num, pct, ratio, tasaTxt } from '../format';

interface FilaCampana {
  campana: string;
  dias: number;
  enviados: number;
  fallidos: number;
  entregados: number;
  leidos: number;
  respondieron: number;
  respondieron_tarde: number;
  no_respondieron: number;
  pendientes: number;
  citas_confirmadas: number;
  citas_canceladas: number;
}
interface Datos {
  rango: { grano: string };
  porCampana: FilaCampana[];
  serie: { periodo: string; campana: string | null; enviados: number }[];
  entregaDesde: string | null;
}
interface Tiempos {
  respuesta: { campana: string; hora: number; enviados: number; acumulado: number }[];
  lectura: { leidos: number; entregados: number; mediana_lectura_min: number | null; mediana_respuesta_min: number | null };
}
interface Calidad {
  errores: { codigo: string; error: string; n: number; desde: string; hasta: string }[];
  telefonos: { pacientes: number; sin_telefono_valido: number; no_movil: number };
  compartidos: { numeros: number; pacientes: number };
}
interface TelefonoInvalido {
  nombre_completo: string;
  tipo_documento: string | null;
  numero_documento: string;
  numero_contacto: string | null;
  email: string | null;
  registrado: string | null;
  problema: string;
}

const COLS_ERROR: Columna<Calidad['errores'][number]>[] = [
  { clave: 'error', titulo: 'Error de WhatsApp', envolver: true },
  { clave: 'codigo', titulo: 'Código' },
  { clave: 'n', titulo: 'Envíos', num: true },
  { clave: 'desde', titulo: 'Desde', formato: fecha },
  { clave: 'hasta', titulo: 'Hasta', formato: fecha },
];
const COLS_TEL: Columna<TelefonoInvalido>[] = [
  { clave: 'nombre_completo', titulo: 'Paciente' },
  { clave: 'tipo_documento', titulo: 'Tipo doc.' },
  { clave: 'numero_documento', titulo: 'Documento' },
  { clave: 'numero_contacto', titulo: 'Teléfono registrado' },
  { clave: 'email', titulo: 'Correo' },
  { clave: 'problema', titulo: 'Problema' },
];

const minutosTxt = (m: number | null) =>
  m === null || m === undefined ? '—' : m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1).replace('.', ',')} h`;

interface Envio {
  enviado: string;
  campana: string;
  nombre_paciente: string | null;
  documento_paciente: string | null;
  telefono_norm: string | null;
  estado: string;
  entregado: boolean;
  leido: boolean;
  estado_respuesta: string;
  respondido: string | null;
  fecha_cita: string | null;
  hora_cita: string | null;
  estado_cita_actual: string | null;
  cita_confirmada_despues: boolean;
  cita_cancelada_despues: boolean;
  error_titulo: string | null;
}

const PRINCIPALES = ['execute', 'reminder', 'daily', 'recuperacion', 'conasistencia'];
const si = (v: boolean) => (v ? 'Sí' : '—');

const COLS_CAMPANA: Columna<FilaCampana>[] = [
  { clave: 'campana', titulo: 'Campaña', formato: etiqueta, csv: etiqueta },
  { clave: 'dias', titulo: 'Días con envíos', num: true },
  { clave: 'enviados', titulo: 'Enviados', num: true },
  { clave: 'fallidos', titulo: 'Fallidos', num: true },
  { clave: 'leidos', titulo: 'Leídos', num: true },
  {
    clave: 'respondieron',
    titulo: 'Respondieron',
    num: true,
    formato: (_v, f) => `${num(f.respondieron + f.respondieron_tarde)} (${pct(f.respondieron + f.respondieron_tarde, f.enviados, 0)})`,
    csv: (_v, f) => String(f.respondieron + f.respondieron_tarde),
    orden: (f) => f.respondieron + f.respondieron_tarde,
  },
  {
    clave: 'citas_confirmadas',
    titulo: 'Confirmaron la cita',
    num: true,
    formato: (v, f) => (v ? `${num(v)} (${pct(v, f.enviados, 0)})` : '—'),
    csv: (v) => String(v ?? 0),
  },
  { clave: 'citas_canceladas', titulo: 'Cancelaron la cita', num: true },
];

const COLS_ENVIO: Columna<Envio>[] = [
  { clave: 'enviado', titulo: 'Enviado', formato: fechaHora, csv: (v) => String(v ?? '') },
  { clave: 'campana', titulo: 'Campaña', formato: etiqueta, csv: etiqueta },
  { clave: 'nombre_paciente', titulo: 'Paciente' },
  { clave: 'documento_paciente', titulo: 'Documento' },
  { clave: 'telefono_norm', titulo: 'Teléfono' },
  { clave: 'leido', titulo: 'Leído', formato: si, csv: si },
  { clave: 'estado_respuesta', titulo: 'Respuesta', formato: etiqueta, csv: etiqueta },
  { clave: 'fecha_cita', titulo: 'Cita', formato: (v, f) => (v ? `${fecha(v)} ${hora(f.hora_cita)}` : '—'), csv: (v, f) => (v ? `${v} ${hora(f.hora_cita)}` : '') },
  { clave: 'estado_cita_actual', titulo: 'Estado actual de la cita' },
  { clave: 'cita_confirmada_despues', titulo: 'Confirmó', formato: si, csv: si },
  { clave: 'error_titulo', titulo: 'Error' },
];

const TAM = 50;

function CampanasResultados({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Datos>(conRango('/api/campanas', rango), 60_000);
  const tiempos = useApi<Tiempos>(conRango('/api/campanas/tiempos', rango), 120_000);
  const calidad = useApi<Calidad>(conRango('/api/campanas/calidad', rango), 300_000);
  const sombras = useSombras(['whatsapp', 'trazabilidad']);
  const [exportandoTel, setExportandoTel] = useState(false);
  const [campana, setCampana] = useState('');
  const [respuesta, setRespuesta] = useState('');
  const [pagina, setPagina] = useState(1);
  const [exportando, setExportando] = useState(false);

  const filtros = { campana, respuesta };
  const urlEnvios = conRango('/api/campanas/envios', rango, { ...filtros, pagina, tam: TAM });
  const envios = useApi<{ filas: Envio[]; total: number }>(urlEnvios, 60_000);

  const grupos = useMemo(() => {
    const presentes = new Set((data?.serie ?? []).map((s) => s.campana).filter(Boolean) as string[]);
    const g = PRINCIPALES.filter((c) => presentes.has(c));
    return [...presentes].some((c) => !PRINCIPALES.includes(c)) ? [...g, 'Otras'] : g;
  }, [data]);

  const opcion = useCallback(() => {
    const filas = data!.serie.map((s) => ({ ...s, campana: s.campana && !PRINCIPALES.includes(s.campana) ? 'Otras' : s.campana }));
    const { periodos, series } = pivotar(filas, 'campana', 'enviados', grupos);
    // El color se asigna por el código de campaña; después se traduce el nombre visible.
    const opt = barrasApiladas(periodos, series, data!.rango.grano, sombras) as any;
    opt.series.forEach((s: any) => (s.name = s.name === 'Otras' ? 'Otras' : etiqueta(s.name)));
    return opt;
  }, [data, grupos, sombras]);

  // CAM-06: % acumulado de respuesta según las horas desde el envío, una curva por campaña.
  const optTiempos = useCallback(() => {
    const filas = tiempos.data!.respuesta;
    const horas = [...new Set(filas.map((f) => f.hora))].sort((a, b) => a - b);
    const series: Record<string, (number | null)[]> = {};
    for (const c of ['execute', 'reminder', 'recuperacion', 'conasistencia']) {
      const fc = filas.filter((f) => f.campana === c);
      if (!fc.length) continue;
      series[c] = horas.map((h) => {
        const f = fc.find((x) => x.hora === h);
        return f && f.enviados ? f.acumulado / f.enviados : null;
      });
    }
    const opt = lineas(horas.map(String), series, 'day', undefined, true) as any;
    opt.xAxis.data = horas.map((h) => (h < 24 ? `${h} h` : `${h / 24} d`));
    opt.series.forEach((s: any) => (s.name = etiqueta(s.name)));
    return opt;
  }, [tiempos.data]);

  const exportarTelefonos = async () => {
    setExportandoTel(true);
    try {
      const d = await getJson<{ filas: TelefonoInvalido[] }>('/api/campanas/telefonos-invalidos');
      descargarCsv('pacientes_telefono_a_corregir', d.filas, COLS_TEL);
    } finally {
      setExportandoTel(false);
    }
  };


  const exportar = async () => {
    setExportando(true);
    try {
      const d = await getJson<{ filas: Envio[] }>(conRango('/api/campanas/envios', rango, { ...filtros, pagina: 1, tam: 5000 }));
      descargarCsv(`envios_${rango.desde}_${rango.hasta}`, d.filas, COLS_ENVIO);
    } finally {
      setExportando(false);
    }
  };

  const total = envios.data?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / TAM));

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tarjeta
            titulo="Resultados por campaña"
            ayuda={`Confirmaron: respondieron "confirmo" o la cita pasó a confirmada después del mensaje. ${
              data.entregaDesde ? `Entregados y leídos se conocen desde el ${fecha(data.entregaDesde)}.` : ''
            }`}
          >
            <Tabla filas={data.porCampana} columnas={COLS_CAMPANA} nombreCsv={`campanas_${rango.desde}_${rango.hasta}`} />
          </Tarjeta>
          <Tarjeta titulo="Mensajes enviados por campaña">
            <Grafico opcion={opcion} />
          </Tarjeta>
        </>
      )}

      {tiempos.data && (
        <div className="grid g2">
          <Tarjeta
            titulo="¿Cuánto tardan en responder?"
            ayuda="Porcentaje de pacientes que ya respondió según el tiempo transcurrido desde el envío. Sirve para decidir cuánto esperar antes de insistir."
          >
            {tiempos.data.respuesta.length ? (
              <Grafico opcion={optTiempos} alto={260} />
            ) : (
              <p className="ayuda">Sin envíos que pidan respuesta en este período.</p>
            )}
          </Tarjeta>
          <Tarjeta titulo="Lectura y respuesta" ayuda="La lectura solo se conoce para envíos desde el 30 sep 2026.">
            <div className="cifras">
              <div className="cifra">
                <div className="n">{minutosTxt(tiempos.data.lectura.mediana_respuesta_min)}</div>
                <div className="t">tiempo típico hasta responder</div>
              </div>
              <div className="cifra">
                <div className="n">{minutosTxt(tiempos.data.lectura.mediana_lectura_min)}</div>
                <div className="t">tiempo típico hasta leer</div>
              </div>
              <div className="cifra">
                <div className="n">{tasaTxt(ratio(tiempos.data.lectura.leidos, tiempos.data.lectura.entregados), 0)}</div>
                <div className="t">de los mensajes entregados fueron leídos</div>
              </div>
            </div>
          </Tarjeta>
        </div>
      )}

      {calidad.data && (
        <div className="grid g2">
          <Tarjeta titulo="Errores de envío" ayuda="Mensajes que WhatsApp no entregó en el período, por motivo.">
            <Tabla filas={calidad.data.errores} columnas={COLS_ERROR} vacio="Sin errores de envío en este período" />
          </Tarjeta>
          <Tarjeta
            titulo="Calidad de los teléfonos"
            ayuda="Estado actual. Un paciente sin teléfono válido no recibe recordatorios."
            accion={
              <button className="boton" disabled={exportandoTel} onClick={exportarTelefonos}>
                {exportandoTel ? 'Preparando…' : 'Descargar para corregir'}
              </button>
            }
          >
            <div className="cifras">
              <div className="cifra">
                <div className="n">{num(calidad.data.telefonos.sin_telefono_valido)}</div>
                <div className="t">pacientes sin teléfono válido</div>
              </div>
              <div className="cifra">
                <div className="n">{num(calidad.data.telefonos.no_movil)}</div>
                <div className="t">con un número que no es celular colombiano</div>
              </div>
              <div className="cifra">
                <div className="n">{num(calidad.data.compartidos.numeros)}</div>
                <div className="t">números compartidos por {num(calidad.data.compartidos.pacientes)} pacientes (familias)</div>
              </div>
            </div>
            <p className="nota">De {num(calidad.data.telefonos.pacientes)} pacientes registrados.</p>
          </Tarjeta>
        </div>
      )}


      <Tarjeta
        titulo="Detalle de mensajes"
        ayuda="Cada mensaje enviado, a quién y qué pasó después."
        accion={<button className="boton" disabled={exportando || total === 0} onClick={exportar}>{exportando ? 'Preparando…' : 'Descargar CSV (hasta 5.000)'}</button>}
      >
        <div className="filtros">
          <select value={campana} onChange={(e) => (setCampana(e.target.value), setPagina(1))}>
            <option value="">Todas las campañas</option>
            {(data?.porCampana ?? []).map((c) => <option key={c.campana} value={c.campana}>{etiqueta(c.campana)}</option>)}
          </select>
          <select value={respuesta} onChange={(e) => (setRespuesta(e.target.value), setPagina(1))}>
            <option value="">Cualquier respuesta</option>
            {['respondio', 'respondio_tarde', 'no_respondio', 'pendiente', 'no_aplica'].map((r) => <option key={r} value={r}>{etiqueta(r)}</option>)}
          </select>
        </div>
        <Estado cargando={envios.cargando} error={envios.error} hayDatos={!!envios.data} />
        {envios.data && (
          <>
            <Tabla filas={envios.data.filas} columnas={COLS_ENVIO} />
            <div className="tabla-pie">
              <span>{num(total)} mensajes · página {pagina} de {paginas}</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="boton" disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>Anterior</button>
                <button className="boton" disabled={pagina >= paginas} onClick={() => setPagina((p) => p + 1)}>Siguiente</button>
              </span>
            </div>
          </>
        )}
      </Tarjeta>
    </>
  );
}

type VistaCampanas = 'resultados' | 'efecto' | 'ejecuciones';

export default function Campanas({ rango }: { rango: Rango }) {
  const [vista, setVista] = usePestana<VistaCampanas>(['resultados', 'efecto', 'ejecuciones'], 'resultados');
  return (
    <>
      <Pestanas<VistaCampanas>
        opciones={[
          ['resultados', 'Resultados'],
          ['efecto', 'Efecto en las citas'],
          ['ejecuciones', 'Ejecuciones'],
        ]}
        valor={vista}
        onCambio={setVista}
      />
      {vista === 'resultados' && <CampanasResultados rango={rango} />}
      {vista === 'efecto' && <CampanasEfecto rango={rango} />}
      {vista === 'ejecuciones' && (
        <Tarjeta
          titulo="Ejecuciones de las campañas"
          ayuda="Cada cuadro es una campaña en un día (últimos 35 días del período). Pase el cursor para ver cuántas citas procesó y cuántos mensajes envió."
        >
          <CalendarioEjecuciones rango={rango} />
        </Tarjeta>
      )}
    </>
  );
}
