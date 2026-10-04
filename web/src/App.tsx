import { useEffect, useState } from 'react';
import { RefrescoCtx, useApi, type Rango } from './api';
import { SelectorRango, rangoPreset } from './components/ui';
import Resumen from './pages/Resumen';
import Campanas from './pages/Campanas';
import Agenda from './pages/Agenda';
import Chatbot from './pages/Chatbot';
import ListaEspera from './pages/ListaEspera';
import Pacientes from './pages/Pacientes';
import Sistema from './pages/Sistema';
import { fecha } from './format';

const PAGINAS = [
  { ruta: 'resumen', titulo: 'Resumen', desc: 'Lo más importante del período', Comp: Resumen, conRango: true },
  { ruta: 'campanas', titulo: 'Campañas', desc: 'Mensajes automáticos de WhatsApp y sus resultados', Comp: Campanas, conRango: true },
  { ruta: 'agenda', titulo: 'Agenda', desc: 'Citas por estado, profesional y especialidad', Comp: Agenda, conRango: true },
  { ruta: 'chatbot', titulo: 'Chatbot', desc: 'Conversaciones con el asistente de WhatsApp', Comp: Chatbot, conRango: true },
  { ruta: 'lista-espera', titulo: 'Lista de espera', desc: 'Inscripciones, cupos liberados y ofertas', Comp: ListaEspera, conRango: true },
  { ruta: 'pacientes', titulo: 'Pacientes', desc: 'Historial completo de un paciente', Comp: Pacientes, conRango: false },
  { ruta: 'sistema', titulo: 'Estado del sistema', desc: '¿Está funcionando todo?', Comp: Sistema, conRango: false },
] as const;

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
 * así un enlace copiado abre exactamente la misma vista.
 */
function leerUrl(): Estado {
  const [rutaCruda, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const ruta = PAGINAS.some((p) => p.ruta === rutaCruda) ? rutaCruda : 'resumen';
  const q = new URLSearchParams(query);
  const desde = q.get('desde');
  const hasta = q.get('hasta');
  if (desde && hasta && FECHA.test(desde) && FECHA.test(hasta)) return { ruta, rango: { desde, hasta }, preset: 'custom' };
  const preset = q.get('p') ?? leerAlmacen('panel.preset') ?? '30d';
  return { ruta, rango: rangoPreset(preset === 'custom' ? '30d' : preset), preset: preset === 'custom' ? '30d' : preset };
}

function escribirUrl(e: Estado) {
  const q = e.preset === 'custom' ? `desde=${e.rango.desde}&hasta=${e.rango.hasta}` : `p=${e.preset}`;
  const hash = `#/${e.ruta}?${q}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

type Tema = 'auto' | 'light' | 'dark';

function aplicarTema(t: Tema) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

const horaActual = () => new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });

export default function App() {
  const [estado, setEstado] = useState<Estado>(leerUrl);
  const [tema, setTema] = useState<Tema>(() => (leerAlmacen('panel.tema') as Tema) || 'auto');
  const [refresco, setRefresco] = useState(0);
  const [horaDatos, setHoraDatos] = useState(horaActual);
  const yo = useApi<{ usuario: string | null }>('/api/yo');

  useEffect(() => {
    const fn = () => setEstado(leerUrl());
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);

  useEffect(() => escribirUrl(estado), [estado]);

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

  const pagina = PAGINAS.find((p) => p.ruta === estado.ruta)!;
  const { Comp } = pagina;
  const sufijo = estado.preset === 'custom' ? `?desde=${estado.rango.desde}&hasta=${estado.rango.hasta}` : `?p=${estado.preset}`;

  return (
    <RefrescoCtx.Provider value={refresco}>
      <div className="app">
        <nav className="nav">
          <h1>Centro de Orientación</h1>
          <p className="sub">Panel de reportes</p>
          {PAGINAS.map((p) => (
            <a key={p.ruta} href={`#/${p.ruta}${sufijo}`} className={p.ruta === estado.ruta ? 'activo' : ''}>{p.titulo}</a>
          ))}
          <div className="pie">
            <label>
              Tema{' '}
              <select value={tema} onChange={(e) => setTema(e.target.value as Tema)} aria-label="Tema">
                <option value="auto">Automático</option>
                <option value="light">Claro</option>
                <option value="dark">Oscuro</option>
              </select>
            </label>
            {yo.data?.usuario && <span>Sesión: {yo.data.usuario}</span>}
          </div>
        </nav>
        <main>
          <div
            className="cabecera"
            data-impreso={`Período: ${fecha(estado.rango.desde)} a ${fecha(estado.rango.hasta)} · Generado el ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`}
          >
            <div>
              <h2>{pagina.titulo}</h2>
              <p>{pagina.desc}</p>
            </div>
            {pagina.conRango && <SelectorRango rango={estado.rango} preset={estado.preset} onCambio={cambiarRango} />}
          </div>
          <div className="herramientas" style={{ marginTop: -8, marginBottom: 16 }}>
            <span>Datos de las {horaDatos} · se actualizan solos</span>
            <button onClick={actualizar}>Actualizar ahora</button>
            <button onClick={imprimir}>Imprimir / PDF</button>
          </div>
          <Comp rango={estado.rango} />
        </main>
      </div>
    </RefrescoCtx.Provider>
  );
}
