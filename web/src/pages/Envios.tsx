import { useEffect, useState } from 'react';
import { enviarJson, getJson, useApi, type Rango } from '../api';
import { Kpi, ListaConteo, Tabla, Tarjeta, Estado, type Columna } from '../components/ui';
import { useAcceso } from '../acceso';
import { fecha, fechaHora, hora, num } from '../format';

// Envíos manuales: barrido de la campaña de invitación a la lista de espera. Primero "Consultar citas" muestra
// exactamente a quiénes se invitaría (en el orden de envío); después "Enviar" le pide al bot que las mande.
// El servidor (server/routes/envios.ts) no decide nada: la elegibilidad es la del backend y el envío lo hace el bot.

interface Resumen {
  fecha_corte: string;
  total_evaluadas: number;
  total_elegibles: number;
  excluidas: Record<string, number>;
  pacientes_varias_citas: number;
  dentro_de_horario_contacto?: boolean;
  horario_contacto?: { inicio: string; fin: string };
  max_por_ejecucion: number;
}
interface Fila {
  orden: number;
  agenda_id: string;
  paciente?: string | null;
  documento_paciente?: string | null;
  telefono_norm?: string | null;
  fecha_cita?: string | null;
  hora_cita?: string | null;
  profesional?: string | null;
  especialidad?: string | null;
}
interface Previsualizacion {
  resumen: Resumen;
  filtros: { fecha_desde: string | null; fecha_hasta: string | null };
  filas: Fila[];
}
interface Ejecucion {
  ejecucion_id: string;
  origen: string;
  estado: string;
  motivo_fin: string | null;
  total_elegibles: number;
  tope: number | null;
  fecha_desde: string | null;
  fecha_hasta: string | null;
  iniciada: string;
  finalizada: string | null;
  reservadas: number;
  enviadas: number;
  errores: number;
  pendientes: number;
  aceptadas: number;
  rechazadas: number;
  sin_respuesta: number;
  descartadas: number;
  lanzada_por: string | null;
}
interface Historial {
  ejecuciones: Ejecucion[];
  en_curso: boolean;
}

/** Motivos por los que una cita no recibe invitación (contadores del backend). */
const MOTIVOS: Record<string, string> = {
  cita_hoy: 'La cita es hoy',
  anticipacion_insuficiente: 'Faltan pocos días para la cita (no se podría adelantar)',
  sin_paciente: 'La cita no tiene paciente asociado',
  sin_profesional: 'La cita no tiene profesional asociado',
  profesional_inactivo: 'El profesional está inactivo',
  telefono_invalido: 'Sin celular válido',
  inscripcion_activa: 'Ya está inscrito en la lista de espera',
  invitacion_previa: 'Esa cita ya fue invitada',
  invitacion_en_curso_par: 'Tiene otra invitación esperando respuesta',
  cooldown_rechazo: 'Rechazó una invitación hace poco (90 días)',
  cooldown_sin_respuesta: 'No respondió una invitación hace poco (30 días)',
  cooldown_consumida: 'Salió de la lista hace poco (30 días)',
  otra_cita_mas_proxima: 'Tiene una cita más próxima con el mismo profesional (se invita por esa)',
  no_piloto: 'Fuera de la lista piloto',
  telefono_ya_invitado_hoy: 'Su celular ya recibe otra invitación hoy (se invita otro día)',
};

const ESTADO_EJECUCION: Record<string, string> = { en_curso: 'Enviando…', finalizada: 'Terminada', abortada: 'Detenida' };
const MOTIVO_FIN: Record<string, string> = {
  sin_candidatas: 'No quedaban citas por invitar',
  limite_alcanzado: 'Se envió la cantidad pedida',
  fuera_de_horario: 'Se detuvo: fuera del horario de contacto',
  deshabilitada: 'Se detuvo: invitaciones apagadas en el bot',
  error: 'Se detuvo por un error',
  config_incompleta: 'Falta configuración',
};

const COLS_LISTA: Columna<Fila>[] = [
  { clave: 'orden', titulo: '#', num: true },
  { clave: 'paciente', titulo: 'Paciente', envolver: true },
  { clave: 'documento_paciente', titulo: 'Documento' },
  { clave: 'telefono_norm', titulo: 'Celular' },
  { clave: 'fecha_cita', titulo: 'Fecha de la cita', formato: (v) => fecha(v) },
  { clave: 'hora_cita', titulo: 'Hora', formato: (v) => hora(v) },
  { clave: 'profesional', titulo: 'Profesional', envolver: true },
  { clave: 'especialidad', titulo: 'Especialidad' },
];

const COLS_HIST: Columna<Ejecucion>[] = [
  { clave: 'iniciada', titulo: 'Inicio', formato: (v) => fechaHora(v) },
  { clave: 'lanzada_por', titulo: 'Lanzada por', formato: (v, f) => v ?? (f.origen === 'cron' ? 'Automática' : '—') },
  { clave: 'estado', titulo: 'Estado', formato: (v, f) => (v === 'en_curso' ? ESTADO_EJECUCION[v] : MOTIVO_FIN[f.motivo_fin ?? ''] ?? ESTADO_EJECUCION[v] ?? v) },
  { clave: 'tope', titulo: 'Pedidas', num: true, formato: (v) => num(v) },
  { clave: 'enviadas', titulo: 'Enviadas', num: true, formato: (v) => num(v) },
  { clave: 'errores', titulo: 'Con error', num: true, formato: (v) => num(v) },
  { clave: 'aceptadas', titulo: 'Aceptaron', num: true, formato: (v) => num(v) },
  { clave: 'rechazadas', titulo: 'Rechazaron', num: true, formato: (v) => num(v) },
  { clave: 'sin_respuesta', titulo: 'Sin respuesta (72 h)', num: true, formato: (v) => num(v) },
];

const qs = (desde: string, hasta: string) => {
  const p = new URLSearchParams();
  if (desde) p.set('fecha_desde', desde);
  if (hasta) p.set('fecha_hasta', hasta);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export default function Envios(_: { rango: Rango }) {
  const { puede } = useAcceso();
  const puedeEnviar = puede('envios.ejecutar');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [previa, setPrevia] = useState<Previsualizacion | null>(null);
  const [consultando, setConsultando] = useState(false);
  const [errorPrevia, setErrorPrevia] = useState<string | null>(null);
  const [cantidad, setCantidad] = useState<number>(0);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null);

  // Tras enviar, y mientras haya un envío en curso, el historial se refresca cada 5 s. Los 20 s después del clic
  // cubren el rato en que el bot todavía no ha creado la ejecución.
  const [vigilarDesde, setVigilarDesde] = useState<number | null>(null);
  const [enCursoPrevio, setEnCursoPrevio] = useState(false);
  const hist = useApi<Historial>('/api/envios/invitacion/historial', vigilarDesde !== null || enCursoPrevio ? 5_000 : 60_000);
  const enCurso = !!hist.data?.en_curso;
  useEffect(() => {
    setEnCursoPrevio(enCurso);
    if (vigilarDesde !== null && !enCurso && Date.now() - vigilarDesde > 20_000) setVigilarDesde(null);
  }, [hist.data, enCurso, vigilarDesde]);

  const consultar = async () => {
    setConsultando(true);
    setErrorPrevia(null);
    setResultado(null);
    try {
      const d = await getJson<Previsualizacion>(`/api/envios/invitacion/previsualizar${qs(desde, hasta)}`);
      setPrevia(d);
      setCantidad(Math.min(d.resumen.total_elegibles, d.resumen.max_por_ejecucion));
    } catch (e) {
      setPrevia(null);
      setErrorPrevia((e as Error).message);
    } finally {
      setConsultando(false);
    }
  };

  const enviar = async () => {
    if (!previa || cantidad < 1) return;
    const ok = window.confirm(
      `Se enviará la invitación a la lista de espera por WhatsApp a ${num(cantidad)} pacientes.\n\n` +
        'No se puede deshacer. ¿Desea continuar?',
    );
    if (!ok) return;
    setEnviando(true);
    setResultado(null);
    try {
      const r = await enviarJson<{ mensaje: string }>('POST', '/api/envios/invitacion/ejecutar', {
        limite: cantidad,
        fecha_desde: previa.filtros.fecha_desde,
        fecha_hasta: previa.filtros.fecha_hasta,
        elegibles_previstos: previa.resumen.total_elegibles,
      });
      setResultado({ ok: true, texto: `${r.mensaje} Los mensajes salen de a uno (unos 3 segundos cada uno); el avance se ve abajo.` });
      // La lista ya no es vigente: los que se envíen dejan de ser elegibles.
      setPrevia(null);
      setVigilarDesde(Date.now());
      setTimeout(() => hist.recargar(), 3_000);
    } catch (e) {
      setResultado({ ok: false, texto: (e as Error).message });
    } finally {
      setEnviando(false);
    }
  };

  const r = previa?.resumen;
  const excluidas = r
    ? Object.entries(r.excluidas)
        .filter(([k, n]) => n > 0 && MOTIVOS[k])
        .map(([k, n]) => ({ clave: k, etiqueta: MOTIVOS[k], n }))
        .sort((a, b) => b.n - a.n)
    : [];
  const totalExcluidas = excluidas.reduce((s, e) => s + e.n, 0);
  const fueraDeHorario = r?.dentro_de_horario_contacto === false;
  const opciones = r ? [50, 100, 200, r.max_por_ejecucion].filter((n, i, a) => n <= Math.min(r.total_elegibles, r.max_por_ejecucion) && a.indexOf(n) === i) : [];
  if (r && r.total_elegibles > 0 && !opciones.includes(Math.min(r.total_elegibles, r.max_por_ejecucion))) {
    opciones.push(Math.min(r.total_elegibles, r.max_por_ejecucion));
  }
  const ultimaEnCurso = hist.data?.ejecuciones.find((e) => e.estado === 'en_curso');

  return (
    <>
      <Tarjeta
        titulo="Invitación a la lista de espera"
        ayuda="Invita por WhatsApp a pacientes con una cita futura a inscribirse en la lista de espera, para avisarles si se libera un cupo antes con su mismo profesional. Su cita no cambia. Primero consulte a quiénes se invitaría; después envíe."
      >
        <div className="filtros" style={{ alignItems: 'flex-end' }}>
          <label>
            <div className="nota" style={{ margin: '0 0 4px' }}>Citas desde (opcional)</div>
            <input type="date" value={desde} onChange={(e) => (setDesde(e.target.value), setPrevia(null))} />
          </label>
          <label>
            <div className="nota" style={{ margin: '0 0 4px' }}>Citas hasta (opcional)</div>
            <input type="date" value={hasta} onChange={(e) => (setHasta(e.target.value), setPrevia(null))} />
          </label>
          <button className="boton boton-primario" onClick={consultar} disabled={consultando}>
            {consultando ? 'Consultando…' : 'Consultar citas'}
          </button>
        </div>
        <p className="nota" style={{ marginTop: 0 }}>
          Sin fechas, se consideran todas las citas futuras que ya estaban en la agenda. Las citas que llegan nuevas cada día
          las invita sola la campaña automática.
        </p>
        {errorPrevia && <div className="error">No se pudo consultar: {errorPrevia}</div>}
        {resultado && <div className={resultado.ok ? 'aviso' : 'error'} style={{ marginTop: 12 }}>{resultado.texto}</div>}
      </Tarjeta>

      {previa && r && (
        <>
          <div className="kpis">
            <Kpi etiqueta="Citas futuras revisadas" actual={r.total_evaluadas} />
            <Kpi etiqueta="Se invitarían" actual={r.total_elegibles} />
            <Kpi etiqueta="No se invitan" actual={totalExcluidas} />
          </div>

          <Tarjeta
            titulo={r.total_elegibles ? `Enviar la invitación` : 'No hay pacientes para invitar'}
            ayuda={
              r.total_elegibles
                ? `Se envía en el orden de la lista (las citas más próximas primero). Máximo ${num(r.max_por_ejecucion)} por envío${
                    r.total_elegibles > r.max_por_ejecucion ? `: para el resto, vuelva a consultar y enviar cuando termine este` : ''
                  }.`
                : 'Con los filtros elegidos no queda ninguna cita por invitar.'
            }
          >
            {r.total_elegibles > 0 && (
              <div className="filtros" style={{ alignItems: 'center', marginBottom: 0 }}>
                <select value={cantidad} onChange={(e) => setCantidad(Number(e.target.value))} disabled={!puedeEnviar || enviando}>
                  {opciones.map((n) => (
                    <option key={n} value={n}>
                      {n === Math.min(r.total_elegibles, r.max_por_ejecucion) ? `Todos (${num(n)})` : `Los primeros ${num(n)}`}
                    </option>
                  ))}
                </select>
                <button
                  className="boton boton-primario"
                  onClick={enviar}
                  disabled={!puedeEnviar || enviando || fueraDeHorario || enCurso || cantidad < 1}
                >
                  {enviando ? 'Enviando…' : `Enviar a ${num(cantidad)} pacientes`}
                </button>
              </div>
            )}
            {!puedeEnviar && <p className="nota">Solo la dirección puede lanzar el envío. Usted puede ver la lista y el avance.</p>}
            {fueraDeHorario && r.horario_contacto && (
              <p className="nota">
                Fuera del horario de contacto con pacientes ({r.horario_contacto.inicio} a {r.horario_contacto.fin}). Podrá enviar dentro de ese horario.
              </p>
            )}
            {enCurso && <p className="nota">Hay un envío en curso: espere a que termine para lanzar otro.</p>}
          </Tarjeta>

          <Tarjeta titulo={`A quiénes se invitaría (${num(previa.filas.length)})`} ayuda={`Lista calculada el ${fecha(r.fecha_corte)}. Si pasa un rato antes de enviar, vuelva a consultar.`}>
            <Tabla filas={previa.filas} columnas={COLS_LISTA} vacio="Nadie para invitar con estos filtros" />
          </Tarjeta>

          {excluidas.length > 0 && (
            <Tarjeta titulo="Por qué no se invita a las demás" ayuda="Cada cita cuenta en el primer motivo que le aplica.">
              <ListaConteo items={excluidas} total={totalExcluidas} />
            </Tarjeta>
          )}
        </>
      )}

      <Tarjeta
        titulo="Envíos realizados"
        ayuda="Envíos del barrido, manuales y automáticos. Las respuestas de los pacientes se van sumando a medida que contestan."
      >
        <Estado cargando={hist.cargando} error={hist.error} hayDatos={!!hist.data} forma="bloque" />
        {ultimaEnCurso && (
          <div className="aviso">
            Enviando: {num(ultimaEnCurso.enviadas)} de {num(ultimaEnCurso.tope ?? ultimaEnCurso.reservadas)} invitaciones
            {ultimaEnCurso.errores ? ` (${num(ultimaEnCurso.errores)} con error)` : ''}.
            <div style={{ height: 6, background: 'var(--grid)', borderRadius: 4, marginTop: 8 }}>
              <div
                style={{
                  height: 6,
                  borderRadius: 4,
                  background: 'var(--accent)',
                  width: `${Math.min(100, Math.round((100 * ultimaEnCurso.enviadas) / Math.max(1, ultimaEnCurso.tope ?? ultimaEnCurso.reservadas)))}%`,
                }}
              />
            </div>
          </div>
        )}
        {hist.data && <Tabla filas={hist.data.ejecuciones} columnas={COLS_HIST} vacio="Todavía no se ha hecho ningún envío" />}
      </Tarjeta>
    </>
  );
}
