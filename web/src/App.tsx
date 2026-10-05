import { useEffect, useState, type ComponentType } from 'react';
import { RefrescoCtx, cambiarVistaPrevia, registrar, useApi, useConexion, type Rango } from './api';
import { SelectorRango, rangoPreset } from './components/ui';
import Resumen from './pages/Resumen';
import Campanas from './pages/Campanas';
import Agenda from './pages/Agenda';
import Chatbot from './pages/Chatbot';
import ListaEspera from './pages/ListaEspera';
import Pacientes from './pages/Pacientes';
import Alertas from './pages/Alertas';
import Marketing from './pages/Marketing';
import Profesionales from './pages/Profesionales';
import Capacidad from './pages/Capacidad';
import MiAgenda from './pages/MiAgenda';
import MiPlan from './pages/MiPlan';
import Soporte from './pages/Soporte';
import { IncidentesCtx, type Incidente } from './incidentes';
import { AccesoCtx, Bloqueado, Candado, type Yo } from './acceso';
import { fecha } from './format';
import Campanita from './components/Campanita';
import { Icono } from './components/iconos';

interface Pagina {
  ruta: string;
  titulo: string;
  desc: string;
  Comp: ComponentType<{ rango: Rango }>;
  conRango: boolean;
  /** Función principal: decide el plan que se muestra cuando la página entera está bloqueada. */
  funcion: string;
}

const PAGINAS: Pagina[] = [
  { ruta: 'resumen', titulo: 'Resumen', desc: 'Lo más importante del período', Comp: Resumen, conRango: true, funcion: 'resumen.kpis' },
  { ruta: 'campanas', titulo: 'Campañas', desc: 'Mensajes automáticos de WhatsApp y sus resultados', Comp: Campanas, conRango: true, funcion: 'campanas.resultados' },
  { ruta: 'agenda', titulo: 'Agenda', desc: 'Citas por estado, profesional y especialidad', Comp: Agenda, conRango: true, funcion: 'agenda.periodo' },
  { ruta: 'capacidad', titulo: 'Capacidad', desc: 'Dónde sobra y dónde falta agenda, cuánto se espera y qué se puede recuperar', Comp: Capacidad, conRango: true, funcion: 'capacidad.centro' },
  { ruta: 'mi-agenda', titulo: 'Mi agenda', desc: 'Sus próximas citas, sus pacientes y su horario', Comp: MiAgenda, conRango: true, funcion: 'miagenda.ver' },
  { ruta: 'profesionales', titulo: 'Profesionales', desc: 'Agenda, asistencia y continuidad de cada profesional', Comp: Profesionales, conRango: true, funcion: 'profesionales.lista' },
  { ruta: 'chatbot', titulo: 'Chatbot', desc: 'Conversaciones con el asistente de WhatsApp', Comp: Chatbot, conRango: true, funcion: 'chatbot.conversaciones' },
  { ruta: 'lista-espera', titulo: 'Lista de espera', desc: 'Inscripciones, cupos liberados y ofertas', Comp: ListaEspera, conRango: true, funcion: 'listaEspera.inscritos' },
  { ruta: 'pacientes', titulo: 'Pacientes', desc: 'Quiénes son, cuántos llegan y cada cuánto vuelven', Comp: Pacientes, conRango: true, funcion: 'pacientes.panorama' },
  { ruta: 'marketing', titulo: 'Marketing', desc: 'Alcance de WhatsApp y pacientes para invitar a volver', Comp: Marketing, conRango: false, funcion: 'marketing.alcance' },
  { ruta: 'alertas', titulo: 'Alertas', desc: 'Lo que requiere atención y la salud de los datos', Comp: Alertas, conRango: true, funcion: 'alertas.panel' },
  { ruta: 'plan', titulo: 'Mi plan', desc: 'Lo que incluye cada plan del panel', Comp: MiPlan, conRango: false, funcion: 'plan.ver' },
  { ruta: 'soporte', titulo: 'Soporte', desc: 'Salud técnica del sistema, licencia, usuarios y actividad', Comp: Soporte, conRango: false, funcion: '' },
];

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

interface Estado {
  ruta: string;
  rango: Rango;
  preset: string;
}

function leerAlmacen(clave: string): string | null {
  try {
    return localStorage.getItem(clave);
  } catch {
    return null;
  }
}
function guardarAlmacen(clave: string, valor: string) {
  try {
    localStorage.setItem(clave, valor);
  } catch {
    /* almacenamiento no disponible */
  }
}

/**
 * La URL guarda la pantalla y el período (#/campanas?p=30d o #/campanas?desde=..&hasta=..),
 * así un enlace copiado abre exactamente la misma vista. Una ruta vacía o desconocida queda en '' y se
 * resuelve con la pantalla de inicio del rol.
 */
function leerUrl(): Estado {
  const [rutaCruda, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const destino = rutaCruda === 'sistema' ? 'alertas' : rutaCruda;
  const ruta = PAGINAS.some((p) => p.ruta === destino) ? destino : '';
  const q = new URLSearchParams(query);
  const desde = q.get('desde');
  const hasta = q.get('hasta');
  if (desde && hasta && FECHA.test(desde) && FECHA.test(hasta)) return { ruta, rango: { desde, hasta }, preset: 'custom' };
  const preset = q.get('p') ?? leerAlmacen('panel.preset') ?? '30d';
  return { ruta, rango: rangoPreset(preset === 'custom' ? '30d' : preset), preset: preset === 'custom' ? '30d' : preset };
}

function escribirUrl(e: Estado) {
  if (!e.ruta) return;
  const pestana = new URLSearchParams(location.hash.split('?')[1] ?? '').get('t');
  const [rutaActual] = location.hash.replace(/^#\/?/, '').split('?');
  const t = pestana && rutaActual === e.ruta ? `&t=${pestana}` : '';
  const q = (e.preset === 'custom' ? `desde=${e.rango.desde}&hasta=${e.rango.hasta}` : `p=${e.preset}`) + t;
  const hash = `#/${e.ruta}?${q}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

type Tema = 'auto' | 'light' | 'dark';

function aplicarTema(t: Tema) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/** El rango no puede empezar antes del historial que permite el plan. */
function recortarRango(r: Rango, minimo: string | null): Rango {
  if (!minimo) return r;
  const desde = r.desde < minimo ? minimo : r.desde;
  const hasta = r.hasta < minimo ? minimo : r.hasta;
  return { desde, hasta };
}

export default function App() {
  const yo = useApi<Yo>('/api/yo');

  if (yo.error && !yo.data) return <div className="pantalla-centro"><div className="error">No se pudo cargar el panel: {yo.error}</div></div>;
  if (!yo.data) return <div className="pantalla-centro"><div className="cargando">Cargando…</div></div>;
  if (!yo.data.habilitado) {
    return (
      <div className="pantalla-centro">
        <section className="card" style={{ maxWidth: 460 }}>
          <h3>Centro de Orientación · Panel de reportes</h3>
          <p>{yo.data.mensaje}</p>
          {yo.data.usuario && <p className="ayuda">Usuario: {yo.data.usuario}</p>}
        </section>
      </div>
    );
  }
  return (
    <AccesoCtx.Provider value={yo.data}>
      <Panel yo={yo.data} />
    </AccesoCtx.Provider>
  );
}

/** Grupos del menú (Etapa 2). Cada persona ve solo las pantallas de su rol; los grupos vacíos no se muestran. */
const GRUPOS: { clave: string; titulo: string; paginas: string[] }[] = [
  { clave: 'direccion', titulo: 'Dirección', paginas: ['resumen'] },
  { clave: 'operacion', titulo: 'Operación', paginas: ['mi-agenda', 'agenda', 'capacidad', 'profesionales', 'lista-espera', 'alertas'] },
  { clave: 'relacion', titulo: 'Relación con pacientes', paginas: ['campanas', 'chatbot', 'pacientes', 'marketing'] },
  { clave: 'cuenta', titulo: 'Su cuenta', paginas: ['plan', 'soporte'] },
];

/** Vista por defecto según el rol: decide qué grupo va primero en el menú. */
const VISTA_ROL: Record<string, string> = { direccion: 'direccion', analista: 'direccion', operacion: 'operacion', relacion: 'relacion', profesional: 'operacion', soporte: 'direccion' };

function haceCuanto(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return 'hace menos de un minuto';
  if (min === 1) return 'hace 1 minuto';
  if (min < 60) return `hace ${min} minutos`;
  const h = Math.floor(min / 60);
  return h === 1 ? 'hace 1 hora' : `hace ${h} horas`;
}

/** "Actualizado hace X min" y un punto de color: verde si el servidor responde, rojo si no. */
function EstadoConexion() {
  const c = useConexion();
  const [, tic] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tic((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (c.caida) {
    return (
      <span className="conexion caida" role="status">
        <span className="punto-inline" /> Sin conexión con el servidor · se reintenta solo
      </span>
    );
  }
  return (
    <span className="conexion" role="status" title={c.ultimoOk ? `Última respuesta: ${new Date(c.ultimoOk).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}` : undefined}>
      <span className="punto-inline" /> {c.ultimoOk ? `Actualizado ${haceCuanto(c.ultimoOk)}` : 'Conectando…'} · se actualiza solo
    </span>
  );
}

function Panel({ yo }: { yo: Yo }) {
  const [estado, setEstado] = useState<Estado>(leerUrl);
  const [tema, setTema] = useState<Tema>(() => (leerAlmacen('panel.tema') as Tema) || 'auto');
  const [refresco, setRefresco] = useState(0);
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [vista, setVista] = useState<string>(() => leerAlmacen('panel.vista') ?? VISTA_ROL[yo.rol ?? ''] ?? 'direccion');
  const incidentes = useApi<{ incidentes: Incidente[] }>('/api/incidentes');
  const verAlertas = yo.funciones['alertas.conteo']?.ok;
  const alertas = useApi<{ n: number; altas: number }>(verAlertas ? '/api/alertas/conteo' : null, 60_000);
  const esSoporte = yo.rolReal === 'soporte';
  const soporte = useApi<{ n: number; altas: number }>(esSoporte ? '/api/soporte/conteo' : null, 60_000);

  const estadoPagina = (ruta: string) => (ruta === 'soporte' ? (esSoporte ? 'ok' : 'oculta') : yo.paginas[ruta]?.estado ?? 'oculta');
  const visibles = PAGINAS.filter((p) => estadoPagina(p.ruta) !== 'oculta');
  const rutaInicio = visibles.find((p) => p.ruta === yo.inicio)?.ruta ?? visibles[0]?.ruta ?? 'plan';
  const ruta = estado.ruta && estadoPagina(estado.ruta) !== 'oculta' ? estado.ruta : rutaInicio;

  // Grupos con al menos una pantalla visible; el de la vista elegida va primero ("Su cuenta" siempre al final).
  const grupos = GRUPOS.map((g) => ({ ...g, paginas: g.paginas.map((r) => visibles.find((p) => p.ruta === r)).filter((p): p is Pagina => !!p) }))
    .filter((g) => g.paginas.length)
    .sort((a, b) => (a.clave === 'cuenta' ? 1 : b.clave === 'cuenta' ? -1 : (a.clave === vista ? -1 : 0) - (b.clave === vista ? -1 : 0)));
  const gruposDeTrabajo = grupos.filter((g) => g.clave !== 'cuenta');

  useEffect(() => {
    const fn = () => (setEstado(leerUrl()), setMenuAbierto(false));
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);

  useEffect(() => escribirUrl({ ...estado, ruta }), [estado, ruta]);
  useEffect(() => registrar('visita', ruta), [ruta]);

  useEffect(() => {
    aplicarTema(tema);
    guardarAlmacen('panel.tema', tema);
  }, [tema]);

  // Al imprimir (botón o Ctrl+P) los gráficos se pintan en modo claro y se restaura el tema después.
  useEffect(() => {
    const antes = () => aplicarTema('light');
    const despues = () => aplicarTema(tema);
    window.addEventListener('beforeprint', antes);
    window.addEventListener('afterprint', despues);
    return () => {
      window.removeEventListener('beforeprint', antes);
      window.removeEventListener('afterprint', despues);
    };
  }, [tema]);

  const cambiarRango = (rango: Rango, preset: string) => {
    setEstado((e) => ({ ...e, rango, preset }));
    if (preset !== 'custom') guardarAlmacen('panel.preset', preset);
  };

  const cambiarVista = (v: string) => {
    setVista(v);
    guardarAlmacen('panel.vista', v);
    const primera = gruposDeTrabajo.find((g) => g.clave === v)?.paginas[0];
    if (primera) location.hash = `#/${primera.ruta}${sufijo}`;
  };

  const imprimir = () => {
    aplicarTema('light');
    // Deja que los gráficos se vuelvan a pintar en claro antes de abrir el diálogo de impresión.
    setTimeout(() => window.print(), 400);
  };

  const pagina = PAGINAS.find((p) => p.ruta === ruta)!;
  const bloqueada = estadoPagina(ruta) === 'bloqueada';
  const { Comp } = pagina;
  const rango = recortarRango(estado.rango, yo.historialDesde);
  const sufijo = estado.preset === 'custom' ? `?desde=${estado.rango.desde}&hasta=${estado.rango.hasta}` : `?p=${estado.preset}`;

  return (
    <RefrescoCtx.Provider value={refresco}>
      <IncidentesCtx.Provider value={incidentes.data?.incidentes ?? []}>
      <div className="app">
        <div className="barra-movil">
          <button className="boton boton-menu" onClick={() => setMenuAbierto(true)} aria-label="Abrir el menú" aria-expanded={menuAbierto}>
            <Icono nombre="menu" />
          </button>
          <span className="barra-movil-titulo">{pagina.titulo}</span>
          {verAlertas && <Campanita conteo={alertas.data} onCambio={alertas.recargar} />}
        </div>
        {menuAbierto && <div className="velo" onClick={() => setMenuAbierto(false)} aria-hidden="true" />}
        <nav className={`nav${menuAbierto ? ' abierta' : ''}`} aria-label="Menú principal">
          <h1>Centro de Orientación</h1>
          <p className="sub">Panel de reportes</p>
          {gruposDeTrabajo.length > 1 && (
            <label className="selector-vista">
              <span>Vista</span>
              <select value={vista} onChange={(e) => cambiarVista(e.target.value)} aria-label="Vista del menú">
                {gruposDeTrabajo.map((g) => <option key={g.clave} value={g.clave}>{g.titulo}</option>)}
              </select>
            </label>
          )}
          <div className="nav-grupos">
            {grupos.map((g) => (
              <div key={g.clave} className="nav-grupo">
                <div className="nav-grupo-titulo">{g.titulo}</div>
                {g.paginas.map((p) => {
                  const candado = estadoPagina(p.ruta) === 'bloqueada';
                  return (
                    <a key={p.ruta} href={`#/${p.ruta}${sufijo}`} className={`${p.ruta === ruta ? 'activo' : ''}${candado ? ' con-candado' : ''}`}>
                      <Icono nombre={p.ruta} />
                      <span className="nav-texto">{p.titulo}</span>
                      {candado && <Candado titulo={`Disponible en el plan ${yo.niveles[yo.paginas[p.ruta].nivel]}`} />}
                      {p.ruta === 'alertas' && (alertas.data?.n ?? 0) > 0 && (
                        <span className={`insignia${alertas.data!.altas ? '' : ' insignia-media'}`} title={`${alertas.data!.n} alertas sin revisar`}>{alertas.data!.n}</span>
                      )}
                      {p.ruta === 'soporte' && (soporte.data?.n ?? 0) > 0 && (
                        <span className={`insignia${soporte.data!.altas ? '' : ' insignia-media'}`} title={`${soporte.data!.n} alertas técnicas activas`}>{soporte.data!.n}</span>
                      )}
                    </a>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="pie">
            <label>
              Tema{' '}
              <select value={tema} onChange={(e) => setTema(e.target.value as Tema)} aria-label="Tema">
                <option value="auto">Automático</option>
                <option value="light">Claro</option>
                <option value="dark">Oscuro</option>
              </select>
            </label>
            {yo.usuario && (
              <span>
                {yo.nombre ?? yo.usuario} · {yo.rolNombre}
              </span>
            )}
            {yo.paginas.plan?.estado === 'ok' && (
              <a href={`#/plan${sufijo}`} className="enlace-plan">Plan {yo.nivelNombre}</a>
            )}
          </div>
        </nav>
        <main>
          {yo.vistaPrevia && (
            <div className="vista-previa">
              <span>
                Vista previa (solo usted la ve): plan <b>{yo.nivelNombre}</b>, rol <b>{yo.rolNombre}</b>.
              </span>
              <button className="boton" onClick={() => cambiarVistaPrevia(null)}>Salir de la vista previa</button>
            </div>
          )}
          <div
            className="cabecera"
            data-impreso={`Período: ${fecha(rango.desde)} a ${fecha(rango.hasta)} · Generado el ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`}
          >
            <div>
              <h2>{pagina.titulo}</h2>
              <p>{pagina.desc}</p>
            </div>
            {pagina.conRango && !bloqueada && <SelectorRango rango={rango} preset={estado.preset} onCambio={cambiarRango} minimo={yo.historialDesde} />}
          </div>
          <div className="herramientas">
            <EstadoConexion />
            <span className="herramientas-acciones">
              <button onClick={() => setRefresco((n) => n + 1)}>Actualizar ahora</button>
              <button onClick={imprimir}>Imprimir / PDF</button>
              {verAlertas && <span className="solo-escritorio"><Campanita conteo={alertas.data} onCambio={alertas.recargar} /></span>}
            </span>
          </div>
          <div className="contenido" key={ruta}>
            {bloqueada ? <Bloqueado clave={pagina.funcion} titulo={pagina.titulo} alto={320} /> : <Comp rango={rango} />}
          </div>
        </main>
      </div>
      </IncidentesCtx.Provider>
    </RefrescoCtx.Provider>
  );
}
