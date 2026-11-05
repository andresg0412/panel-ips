import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getJson, type Rango } from '../api';

// Historial de conversaciones del chatbot: SOLO LECTURA y casi en tiempo real (2 a 5 s). No hay caja de texto ni
// botones de acción: el panel nunca escribe a un paciente ni llama al bot. El servidor
// (server/routes/conversaciones.ts) comparte un solo sondeo entre todas las personas; aquí cada pestaña pregunta
// "¿qué hay después del id X?" cada 3 s (conversación abierta) o cada 10 s (lista), y se detiene si la pestaña
// está oculta. Diseño: proyecto-ips/docs/features/2026-10-29-historial-mensajes-panel.md, sección 6.3.

const SONDEO_CHAT_MS = 3_000;
const SONDEO_LISTA_MS = 10_000;
const ACTIVA_MIN = 15;

interface Conv {
  telefono: string;
  nombre: string | null;
  documento: string | null;
  pacientes_n: number;
  extracto: string | null;
  ultimo_at: string;
  ultima_direccion: string;
  mensajes_total: number;
  flujo: string | null;
  paso: string | null;
  hubo_crisis: boolean;
  ultimo_id: number;
}
interface Lista {
  conversaciones: Conv[];
  max_id: number;
  ahora: string;
  retencion_dias: number;
}
interface Msg {
  id: number;
  direccion: 'entrante' | 'saliente' | 'sistema';
  origen: string;
  tipo: string;
  texto: string | null;
  contenido: Record<string, unknown> | null;
  plantilla: string | null;
  campana: string | null;
  flujo: string | null;
  paso: string | null;
  estado_envio: string | null;
  error_code: string | null;
  en_blacklist: boolean | null;
  ocurrido_at: string;
}
interface Cabecera {
  telefono: string;
  nombre?: string | null;
  documento?: string | null;
  pacientes_n?: number;
  flujo?: string | null;
  paso?: string | null;
  hubo_crisis?: boolean;
}
interface Apertura {
  conversacion: Cabecera;
  mensajes: Msg[];
  hay_mas: boolean;
  max_id: number;
  retencion_dias: number;
}
interface Nuevos {
  mensajes: Msg[];
  estados: { id: number; estado_envio: string | null; error_code: string | null }[];
  max_id: number;
}

const FILTROS: { clave: string; titulo: string }[] = [
  { clave: '', titulo: 'Todas' },
  { clave: 'activas', titulo: 'Activas ahora' },
  { clave: 'hoy', titulo: 'Hoy' },
  { clave: 'plantilla', titulo: 'Respondieron a una plantilla' },
  { clave: 'crisis', titulo: 'Con mensaje de crisis' },
  { clave: 'error', titulo: 'Con error de entrega' },
];

// ------------------------------------------------------------------------------------------ utilidades
const BOGOTA = 'America/Bogota';
const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: BOGOTA, hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDiaClave = new Intl.DateTimeFormat('en-CA', { timeZone: BOGOTA });
const fmtDiaCorto = new Intl.DateTimeFormat('es-CO', { timeZone: BOGOTA, day: 'numeric', month: 'short' });
const fmtCompleta = new Intl.DateTimeFormat('es-CO', { timeZone: BOGOTA, dateStyle: 'medium', timeStyle: 'short' });

const horaDe = (iso: string) => fmtHora.format(new Date(iso));
const diaDe = (iso: string) => fmtDiaClave.format(new Date(iso));
function etiquetaDia(clave: string): string {
  const hoy = fmtDiaClave.format(new Date());
  const ayer = fmtDiaClave.format(new Date(Date.now() - 86_400_000));
  if (clave === hoy) return 'Hoy';
  if (clave === ayer) return 'Ayer';
  return fmtDiaCorto.format(new Date(`${clave}T12:00:00-05:00`)).replace('.', '');
}

function hace(msDesde: number, ahora: number): string {
  const min = Math.floor((ahora - msDesde) / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return fmtDiaCorto.format(new Date(msDesde)).replace('.', '');
}

function leerLeidas(): { base: number | null; leidas: Record<string, number> } {
  try {
    const v = JSON.parse(localStorage.getItem('panel.conversaciones.leidas') ?? 'null');
    if (v && typeof v === 'object' && typeof v.leidas === 'object') return { base: typeof v.base === 'number' ? v.base : null, leidas: v.leidas };
  } catch {
    /* almacenamiento no disponible o dañado */
  }
  return { base: null, leidas: {} };
}
function guardarLeidas(v: { base: number | null; leidas: Record<string, number> }) {
  try {
    localStorage.setItem('panel.conversaciones.leidas', JSON.stringify(v));
  } catch {
    /* almacenamiento no disponible */
  }
}

type EstadoVivo = 'vivo' | 'reconectando' | 'pausa';

/**
 * Sondeo con reglas: una petición a la vez (la siguiente se programa cuando termina la anterior), AbortController,
 * detenido con la pestaña oculta, un sondeo inmediato al volver, y backoff 3 → 6 → 12 → 30 s ante errores.
 * `tarea` se lee de una referencia: cambiar de conversación no reinicia el temporizador por cada render.
 */
function useSondeo(tarea: (signal: AbortSignal) => Promise<void>, baseMs: number, activo: boolean, reinicio: string): EstadoVivo {
  const [estado, setEstado] = useState<EstadoVivo>('vivo');
  const tareaRef = useRef(tarea);
  tareaRef.current = tarea;

  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    let control: AbortController | undefined;
    let fallos = 0;

    const siguiente = () => {
      if (!vivo) return;
      const espera = fallos === 0 ? baseMs : Math.min(30_000, baseMs * 2 ** fallos);
      temporizador = setTimeout(ciclo, espera);
    };
    const ciclo = async () => {
      if (!vivo) return;
      if (document.visibilityState !== 'visible') {
        setEstado('pausa');
        return; // se reanuda en visibilitychange
      }
      control = new AbortController();
      try {
        await tareaRef.current(control.signal);
        fallos = 0;
        if (vivo) setEstado('vivo');
      } catch (e) {
        if ((e as Error)?.name === 'AbortError' || !vivo) return;
        fallos++;
        setEstado(fallos >= 3 ? 'reconectando' : 'vivo');
      }
      siguiente();
    };
    const alCambiarVisibilidad = () => {
      clearTimeout(temporizador);
      if (document.visibilityState === 'visible') {
        setEstado('vivo');
        void ciclo();
      } else {
        control?.abort();
        setEstado('pausa');
      }
    };
    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    // La primera carga la hace quien monta; el primer sondeo va un intervalo después.
    siguiente();
    return () => {
      vivo = false;
      clearTimeout(temporizador);
      control?.abort();
      document.removeEventListener('visibilitychange', alCambiarVisibilidad);
    };
  }, [baseMs, activo, reinicio]);

  return estado;
}

function Indicador({ estado }: { estado: EstadoVivo }) {
  const texto = estado === 'vivo' ? 'En vivo' : estado === 'pausa' ? 'En pausa (pestaña oculta)' : 'Reconectando…';
  return (
    <span className={`conv-vivo conv-vivo-${estado}`} role="status">
      <span className="punto-inline" /> {texto}
    </span>
  );
}

// ------------------------------------------------------------------------------------------- mensajes
const ICONO_TIPO: Record<string, string> = { imagen: '🖼️', audio: '🎤', video: '🎞️', documento: '📄', sticker: '🏷️', ubicacion: '📍', contacto: '👤', reaccion: '😀' };
const NOMBRE_TIPO: Record<string, string> = { imagen: 'Imagen', audio: 'Audio', video: 'Video', documento: 'Documento', sticker: 'Sticker', ubicacion: 'Ubicación', contacto: 'Contacto', reaccion: 'Reacción' };

function Chulitos({ m }: { m: Msg }) {
  if (m.direccion !== 'saliente') return null;
  const e = m.estado_envio;
  if (e === 'failed') return <span className="conv-chulo conv-chulo-error" title={`No se entregó (código ${m.error_code ?? 'desconocido'})`}>⚠</span>;
  if (e === 'error_api') return <span className="conv-chulo conv-chulo-error" title={`Meta rechazó el envío${m.error_code ? ` (código ${m.error_code})` : ''}`}>⚠</span>;
  if (e === 'read') return <span className="conv-chulo conv-chulo-leido" title="Leído">✓✓</span>;
  if (e === 'delivered') return <span className="conv-chulo" title="Entregado">✓✓</span>;
  if (e === 'sent') return <span className="conv-chulo" title="Enviado">✓</span>;
  return <span className="conv-chulo" title="Aceptado por Meta">·</span>;
}

function Chips({ titulos }: { titulos: string[] }) {
  if (!titulos.length) return null;
  return (
    <div className="conv-chips">
      {titulos.map((t, i) => <span key={i} className="conv-chip">{t}</span>)}
    </div>
  );
}

function Cuerpo({ m }: { m: Msg }) {
  const c = m.contenido ?? {};
  if (m.tipo === 'plantilla') {
    return <div className="conv-plantilla">Plantilla enviada: <b>{m.plantilla ?? 'sin nombre'}</b></div>;
  }
  if (m.tipo === 'boton') {
    return <div className="conv-boton-tocado" title="Botón que tocó el paciente">🔘 {m.texto ?? '(botón)'}</div>;
  }
  if (m.tipo === 'lista') {
    return <div className="conv-boton-tocado" title="Opción de la lista que eligió el paciente">☰ {m.texto ?? '(opción)'}</div>;
  }
  if (m.tipo === 'botones') {
    const botones = Array.isArray(c.botones) ? (c.botones as unknown[]).map(String) : [];
    return <><div className="conv-texto">{m.texto}</div><Chips titulos={botones} /></>;
  }
  if (m.tipo === 'lista_opciones') {
    const secciones = Array.isArray(c.secciones) ? (c.secciones as { filas?: unknown[] }[]) : [];
    const filas = secciones.flatMap((s) => (Array.isArray(s.filas) ? s.filas.map(String) : []));
    return <><div className="conv-texto">{m.texto}</div><Chips titulos={filas} /></>;
  }
  if (ICONO_TIPO[m.tipo]) {
    const nombre = NOMBRE_TIPO[m.tipo];
    const archivo = typeof c.archivo === 'string' ? c.archivo : null;
    return (
      <>
        <div className="conv-multimedia">
          {ICONO_TIPO[m.tipo]} {m.direccion === 'entrante' ? `${nombre} enviado por el paciente (no se almacena)` : `${nombre}${archivo ? `: ${archivo}` : ''}`}
        </div>
        {m.texto && <div className="conv-texto">{m.texto}</div>}
      </>
    );
  }
  return <div className="conv-texto">{m.texto ?? `(${m.tipo})`}</div>;
}

function Burbuja({ m }: { m: Msg }) {
  if (m.direccion === 'sistema') {
    return <div className={`conv-sistema${m.origen === 'crisis' ? ' conv-sistema-crisis' : ''}`}>{m.texto ?? 'Evento del sistema'} · {horaDe(m.ocurrido_at)}</div>;
  }
  const entrante = m.direccion === 'entrante';
  return (
    <div className={`conv-fila ${entrante ? 'entrante' : 'saliente'}`}>
      <div className={`conv-burbuja${m.tipo === 'plantilla' ? ' conv-burbuja-plantilla' : ''}`} title={fmtCompleta.format(new Date(m.ocurrido_at))}>
        <Cuerpo m={m} />
        <div className="conv-meta">
          {m.en_blacklist && <span title="El flujo automático estaba bloqueado para este número">bloqueado · </span>}
          {horaDe(m.ocurrido_at)} <Chulitos m={m} />
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- el chat
function Chat({ telefono, aviso, onVolver, onLeido }: { telefono: string; aviso: string; onVolver: () => void; onLeido: (tel: string, id: number) => void }) {
  const [cab, setCab] = useState<Cabecera | null>(null);
  const [mensajes, setMensajes] = useState<Msg[]>([]);
  const [hayMas, setHayMas] = useState(false);
  const [cargado, setCargado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [nuevos, setNuevos] = useState(0);
  const cursor = useRef(0);
  const caja = useRef<HTMLDivElement>(null);
  const irAbajo = useRef(true);
  const alturaPrevia = useRef<number | null>(null);

  const estaAbajo = () => {
    const el = caja.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Apertura: carga los últimos mensajes. Es lo único que queda en la actividad del panel (los sondeos no).
  useEffect(() => {
    const control = new AbortController();
    setCab(null);
    setMensajes([]);
    setHayMas(false);
    setCargado(false);
    setError(null);
    setNuevos(0);
    irAbajo.current = true;
    getJson<Apertura>(`/api/conversaciones/${telefono}/mensajes`, control.signal)
      .then((d) => {
        setCab(d.conversacion);
        setMensajes(d.mensajes);
        setHayMas(d.hay_mas);
        cursor.current = d.max_id;
        setCargado(true);
        if (d.mensajes.length) onLeido(telefono, d.mensajes[d.mensajes.length - 1].id);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => control.abort();
  }, [telefono, onLeido]);

  // Después de pintar: baja al final (primera carga o si ya estaba abajo) o conserva la posición al cargar historial.
  useLayoutEffect(() => {
    const el = caja.current;
    if (!el) return;
    if (alturaPrevia.current !== null) {
      el.scrollTop += el.scrollHeight - alturaPrevia.current;
      alturaPrevia.current = null;
    } else if (irAbajo.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [mensajes]);

  const sondear = useCallback(async (signal: AbortSignal) => {
    if (!cargado) return;
    const d = await getJson<Nuevos>(`/api/conversaciones/${telefono}/mensajes?despues_id=${cursor.current}`, signal);
    cursor.current = Math.max(cursor.current, d.max_id);
    const estados = new Map(d.estados.map((e) => [e.id, e]));
    setMensajes((actuales) => {
      const ids = new Set(actuales.map((m) => m.id));
      const nuevosMsgs = d.mensajes.filter((m) => !ids.has(m.id));
      let cambioEstado = false;
      const conEstados = actuales.map((m) => {
        const e = estados.get(m.id);
        if (!e || (e.estado_envio === m.estado_envio && e.error_code === m.error_code)) return m;
        cambioEstado = true;
        return { ...m, estado_envio: e.estado_envio, error_code: e.error_code };
      });
      // Sin novedades se devuelve el mismo arreglo: un sondeo vacío no debe repintar ni mover el desplazamiento.
      if (!nuevosMsgs.length) return cambioEstado ? conEstados : actuales;
      // Solo salta al final si la persona ya estaba abajo; si subió a leer, se avisa con el botón flotante.
      if (estaAbajo()) irAbajo.current = true;
      else {
        irAbajo.current = false;
        setNuevos((n) => n + nuevosMsgs.length);
      }
      return [...conEstados, ...nuevosMsgs];
    });
    if (d.mensajes.length) onLeido(telefono, d.mensajes[d.mensajes.length - 1].id);
  }, [telefono, cargado, onLeido]);

  const estadoVivo = useSondeo(sondear, SONDEO_CHAT_MS, cargado, telefono);

  const cargarAnteriores = async () => {
    if (cargandoMas || !hayMas || !mensajes.length) return;
    setCargandoMas(true);
    try {
      const d = await getJson<{ mensajes: Msg[]; hay_mas: boolean }>(`/api/conversaciones/${telefono}/mensajes?antes_id=${mensajes[0].id}`);
      alturaPrevia.current = caja.current?.scrollHeight ?? null;
      irAbajo.current = false;
      setMensajes((actuales) => {
        const ids = new Set(actuales.map((m) => m.id));
        return [...d.mensajes.filter((m) => !ids.has(m.id)), ...actuales];
      });
      setHayMas(d.hay_mas);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargandoMas(false);
    }
  };

  const alDesplazar = () => {
    // Si la persona sube a leer, ningún sondeo (ni un cambio de chulitos) la devuelve al final.
    irAbajo.current = estaAbajo();
    if (irAbajo.current) setNuevos(0);
    if ((caja.current?.scrollTop ?? 1) < 40) void cargarAnteriores();
  };

  const bajar = () => {
    irAbajo.current = true;
    setNuevos(0);
    const el = caja.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const filas = useMemo(() => {
    const out: JSX.Element[] = [];
    let dia = '';
    for (const m of mensajes) {
      const d = diaDe(m.ocurrido_at);
      if (d !== dia) {
        dia = d;
        out.push(<div key={`d${d}-${m.id}`} className="conv-dia"><span>{etiquetaDia(d)}</span></div>);
      }
      out.push(<Burbuja key={m.id} m={m} />);
    }
    return out;
  }, [mensajes]);

  return (
    <div className="conv-chat-interno">
      <header className="conv-chat-cab">
        <button className="boton conv-volver" onClick={onVolver} aria-label="Volver a la lista">← Volver</button>
        <div className="conv-chat-quien">
          <b>{cab?.nombre ?? 'Sin identificar'}</b>
          <span>{telefono}{cab?.documento ? ` · documento ${cab.documento}` : ''}</span>
          {(cab?.pacientes_n ?? 0) > 1 && <span className="ayuda">y {(cab?.pacientes_n ?? 1) - 1} paciente(s) más con este número</span>}
          {(cab?.flujo || cab?.paso) && <span className="ayuda">Trámite: {[cab?.flujo, cab?.paso].filter(Boolean).join(' → ')}</span>}
        </div>
        <div className="conv-chat-estado">
          <Indicador estado={estadoVivo} />
          <span className="conv-solo-lectura">Solo lectura: el panel no envía mensajes</span>
        </div>
      </header>
      <div className="conv-caja" ref={caja} onScroll={alDesplazar} aria-live="polite">
        {error && <div className="error">{error}</div>}
        {!cargado && !error && <div className="cargando">Cargando conversación…</div>}
        {hayMas && <button className="boton conv-mas" onClick={() => void cargarAnteriores()} disabled={cargandoMas}>{cargandoMas ? 'Cargando…' : 'Cargar mensajes anteriores'}</button>}
        {filas}
        {cargado && !mensajes.length && <div className="ayuda">Esta conversación no tiene mensajes dentro del período de conservación.</div>}
      </div>
      {nuevos > 0 && <button className="boton boton-primario conv-nuevos" onClick={bajar}>↓ {nuevos} mensaje{nuevos === 1 ? '' : 's'} nuevo{nuevos === 1 ? '' : 's'}</button>}
      <footer className="conv-pie ayuda">{aviso}</footer>
    </div>
  );
}

// -------------------------------------------------------------------------------------------- la lista
export default function Conversaciones(_props: { rango: Rango }) {
  const [filtro, setFiltro] = useState('');
  const [texto, setTexto] = useState('');
  const [buscar, setBuscar] = useState('');
  const [lista, setLista] = useState<Lista | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [reloj, setReloj] = useState(0);
  const [leidas, setLeidas] = useState(leerLeidas);
  const maxId = useRef(0);
  const desfase = useRef(0); // reloj del servidor - reloj local, para "activa ahora"

  // La búsqueda espera a que la persona deje de escribir.
  useEffect(() => {
    const t = setTimeout(() => setBuscar(texto.trim()), 350);
    return () => clearTimeout(t);
  }, [texto]);

  // "hace 2 min" y el punto verde se refrescan solos aunque no lleguen datos nuevos.
  useEffect(() => {
    const t = setInterval(() => setReloj((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const cargarLista = useCallback(async (signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (filtro) q.set('filtro', filtro);
    if (buscar) q.set('buscar', buscar);
    const d = await getJson<Lista>(`/api/conversaciones${q.toString() ? `?${q}` : ''}`, signal);
    maxId.current = d.max_id;
    desfase.current = new Date(d.ahora).getTime() - Date.now();
    setLista(d);
    setError(null);
    setLeidas((actual) => {
      if (actual.base !== null) return actual;
      const nuevo = { ...actual, base: d.max_id }; // primera visita: lo que ya había se da por visto
      guardarLeidas(nuevo);
      return nuevo;
    });
  }, [filtro, buscar]);

  useEffect(() => {
    const control = new AbortController();
    cargarLista(control.signal).catch((e: Error) => e.name !== 'AbortError' && setError(e.message));
    return () => control.abort();
  }, [cargarLista]);

  // Cada 10 s: ¿cambió algo? (consulta barata al buffer del servidor) y solo entonces se vuelve a pedir la lista.
  const sondearLista = useCallback(async (signal: AbortSignal) => {
    const c = await getJson<{ max_id: number; completo: boolean }>(`/api/conversaciones/cursor?desde_id=${maxId.current}`, signal);
    if (!c.completo || c.max_id > maxId.current) await cargarLista(signal);
  }, [cargarLista]);
  const estadoLista = useSondeo(sondearLista, SONDEO_LISTA_MS, !!lista, `${filtro}|${buscar}`);

  const marcarLeido = useCallback((tel: string, id: number) => {
    setLeidas((actual) => {
      if ((actual.leidas[tel] ?? 0) >= id) return actual;
      const nuevo = { ...actual, leidas: { ...actual.leidas, [tel]: id } };
      guardarLeidas(nuevo);
      return nuevo;
    });
  }, []);

  void reloj; // el reloj de 30 s solo fuerza el repintado de "hace 2 min" y del punto verde
  const ahora = Date.now() + desfase.current;
  const retencion = lista?.retencion_dias ?? 30;
  const aviso = `Estas conversaciones contienen datos personales y de salud. Su consulta queda registrada. Se conservan ${retencion} días. Los avisos al asesor no se muestran aquí.`;

  return (
    <div className="conv">
      <div className="conv-aviso" role="note">{aviso}</div>
      <div className={`conv-grid${abierta ? ' con-chat' : ''}`}>
        <aside className="conv-lista" aria-label="Conversaciones">
          <div className="conv-lista-cab">
            <input
              type="search"
              className="conv-buscar"
              placeholder="Buscar por teléfono, documento o nombre"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              aria-label="Buscar conversación"
              maxLength={60}
            />
            <div className="conv-filtros" role="group" aria-label="Filtros">
              {FILTROS.map((f) => (
                <button key={f.clave} className={`conv-filtro${filtro === f.clave ? ' activo' : ''}`} onClick={() => setFiltro(f.clave)} aria-pressed={filtro === f.clave}>
                  {f.titulo}
                </button>
              ))}
            </div>
            <Indicador estado={estadoLista} />
          </div>
          {error && <div className="error">{error}</div>}
          {!lista && !error && <div className="cargando">Cargando conversaciones…</div>}
          {lista && !lista.conversaciones.length && <div className="ayuda conv-vacia">No hay conversaciones{filtro || buscar ? ' con ese filtro' : ' todavía. El historial empieza el día en que se activó la captura'}.</div>}
          <ul className="conv-items">
            {lista?.conversaciones.map((c) => {
              const activa = ahora - new Date(c.ultimo_at).getTime() < ACTIVA_MIN * 60_000;
              const sinLeer = c.ultimo_id > (leidas.leidas[c.telefono] ?? leidas.base ?? Infinity) && abierta !== c.telefono;
              return (
                <li key={c.telefono}>
                  <button className={`conv-item${abierta === c.telefono ? ' activo' : ''}${sinLeer ? ' sin-leer' : ''}`} onClick={() => setAbierta(c.telefono)}>
                    <span className="conv-item-fila">
                      <span className="conv-item-nombre">
                        {activa && <span className="conv-activa" title="Activa ahora" />}
                        {c.nombre ?? 'Sin identificar'}
                        {c.hubo_crisis && (
                          <span className="conv-crisis" title="Se detectó contenido de riesgo y el protocolo de crisis avisó al equipo. Esta pantalla no es una herramienta de atención de crisis ni implica que alguien la vigile en tiempo real.">crisis</span>
                        )}
                      </span>
                      <span className="conv-item-hora">{hace(new Date(c.ultimo_at).getTime(), ahora)}</span>
                    </span>
                    <span className="conv-item-tel">{c.telefono}</span>
                    <span className="conv-item-extracto">{c.ultima_direccion === 'saliente' ? 'Bot: ' : c.ultima_direccion === 'entrante' ? '' : '· '}{c.extracto ?? ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <section className="conv-panel" aria-label="Conversación">
          {abierta ? (
            <Chat telefono={abierta} aviso={aviso} onVolver={() => setAbierta(null)} onLeido={marcarLeido} />
          ) : (
            <div className="conv-vacio ayuda">Elija una conversación de la lista para ver sus mensajes. Es solo lectura: desde aquí no se puede escribir a los pacientes.</div>
          )}
        </section>
      </div>
    </div>
  );
}
