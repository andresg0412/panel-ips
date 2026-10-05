import { useEffect, useState, type ComponentType } from 'react';
import { RefrescoCtx, cambiarVistaPrevia, registrar, useApi, type Rango } from './api';
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
import MiPlan from './pages/MiPlan';
import Soporte from './pages/Soporte';
import { IncidentesCtx, type Incidente } from './incidentes';
import { AccesoCtx, Bloqueado, Candado, type Yo } from './acceso';
import { fecha } from './format';

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

const horaActual = () => new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });

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

function Panel({ yo }: { yo: Yo }) {
  const [estado, setEstado] = useState<Estado>(leerUrl);
  const [tema, setTema] = useState<Tema>(() => (leerAlmacen('panel.tema') as Tema) || 'auto');
  const [refresco, setRefresco] = useState(0);
  const [horaDatos, setHoraDatos] = useState(horaActual);
  const incidentes = useApi<{ incidentes: Incidente[] }>('/api/incidentes');
  const verAlertas = yo.funciones['alertas.conteo']?.ok;
  const alertas = useApi<{ n: number }>(verAlertas ? '/api/alertas/conteo' : null, 60_000);
  const esSoporte = yo.rolReal === 'soporte';
  const soporte = useApi<{ n: number; altas: number }>(esSoporte ? '/api/soporte/conteo' : null, 60_000);

  const estadoPagina = (ruta: string) => (ruta === 'soporte' ? (esSoporte ? 'ok' : 'oculta') : yo.paginas[ruta]?.estado ?? 'oculta');
  const visibles = PAGINAS.filter((p) => estadoPagina(p.ruta) !== 'oculta');
  const rutaInicio = visibles.find((p) => p.ruta === yo.inicio)?.ruta ?? visibles[0]?.ruta ?? 'plan';
  const ruta = estado.ruta && estadoPagina(estado.ruta) !== 'oculta' ? estado.ruta : rutaInicio;

  useEffect(() => {
    const fn = () => setEstado(leerUrl());
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

  const actualizar = () => {
    setRefresco((n) => n + 1);
    setHoraDatos(horaActual());
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
        <nav className="nav">
          <h1>Centro de Orientación</h1>
          <p className="sub">Panel de reportes</p>
          {visibles.map((p) => {
            const candado = estadoPagina(p.ruta) === 'bloqueada';
            return (
              <a key={p.ruta} href={`#/${p.ruta}${sufijo}`} className={`${p.ruta === ruta ? 'activo' : ''}${candado ? ' con-candado' : ''}`}>
                {p.titulo}
                {candado && <Candado titulo={`Disponible en el plan ${yo.niveles[yo.paginas[p.ruta].nivel]}`} />}
                {p.ruta === 'alertas' && (alertas.data?.n ?? 0) > 0 && (
                  <span className="insignia" title={`${alertas.data!.n} alertas activas`}>{alertas.data!.n}</span>
                )}
                {p.ruta === 'soporte' && (soporte.data?.n ?? 0) > 0 && (
                  <span className={`insignia${soporte.data!.altas ? '' : ' insignia-media'}`} title={`${soporte.data!.n} alertas técnicas activas`}>{soporte.data!.n}</span>
                )}
              </a>
            );
          })}
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
          <div className="herramientas" style={{ marginTop: -8, marginBottom: 16 }}>
            <span>Datos de las {horaDatos} · se actualizan solos</span>
            <button onClick={actualizar}>Actualizar ahora</button>
            <button onClick={imprimir}>Imprimir / PDF</button>
          </div>
          {bloqueada ? <Bloqueado clave={pagina.funcion} titulo={pagina.titulo} alto={320} /> : <Comp rango={rango} />}
        </main>
      </div>
      </IncidentesCtx.Provider>
    </RefrescoCtx.Provider>
  );
}
