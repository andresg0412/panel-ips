import { useEffect, useState } from 'react';
import { useApi, type Rango } from './api';
import { SelectorRango, rangoPreset } from './components/ui';
import Resumen from './pages/Resumen';
import Campanas from './pages/Campanas';
import Agenda from './pages/Agenda';
import Chatbot from './pages/Chatbot';
import ListaEspera from './pages/ListaEspera';
import Pacientes from './pages/Pacientes';
import Sistema from './pages/Sistema';

const PAGINAS = [
  { ruta: 'resumen', titulo: 'Resumen', desc: 'Lo más importante del período', Comp: Resumen, conRango: true },
  { ruta: 'campanas', titulo: 'Campañas', desc: 'Mensajes automáticos de WhatsApp y sus resultados', Comp: Campanas, conRango: true },
  { ruta: 'agenda', titulo: 'Agenda', desc: 'Citas por estado, profesional y especialidad', Comp: Agenda, conRango: true },
  { ruta: 'chatbot', titulo: 'Chatbot', desc: 'Conversaciones con el asistente de WhatsApp', Comp: Chatbot, conRango: true },
  { ruta: 'lista-espera', titulo: 'Lista de espera', desc: 'Inscripciones, cupos liberados y ofertas', Comp: ListaEspera, conRango: true },
  { ruta: 'pacientes', titulo: 'Pacientes', desc: 'Historial completo de un paciente', Comp: Pacientes, conRango: false },
  { ruta: 'sistema', titulo: 'Estado del sistema', desc: '¿Está funcionando todo?', Comp: Sistema, conRango: false },
] as const;

function rutaActual(): string {
  const r = location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGINAS.some((p) => p.ruta === r) ? r : 'resumen';
}

function leerPreferencia(): { rango: Rango; preset: string } {
  try {
    const preset = localStorage.getItem('panel.preset');
    if (preset && preset !== 'custom') return { rango: rangoPreset(preset), preset };
  } catch {
    /* almacenamiento no disponible */
  }
  return { rango: rangoPreset('30d'), preset: '30d' };
}

export default function App() {
  const [ruta, setRuta] = useState(rutaActual);
  const [{ rango, preset }, setFiltro] = useState(leerPreferencia);
  const yo = useApi<{ usuario: string | null }>('/api/yo');

  useEffect(() => {
    const fn = () => setRuta(rutaActual());
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);

  const cambiarRango = (r: Rango, p: string) => {
    setFiltro({ rango: r, preset: p });
    try {
      localStorage.setItem('panel.preset', p);
    } catch {
      /* almacenamiento no disponible */
    }
  };

  const pagina = PAGINAS.find((p) => p.ruta === ruta)!;
  const { Comp } = pagina;

  return (
    <div className="app">
      <nav className="nav">
        <h1>Centro de Orientación</h1>
        <p className="sub">Panel de reportes</p>
        {PAGINAS.map((p) => (
          <a key={p.ruta} href={`#/${p.ruta}`} className={p.ruta === ruta ? 'activo' : ''}>{p.titulo}</a>
        ))}
        {yo.data?.usuario && <div className="usuario">Sesión: {yo.data.usuario}</div>}
      </nav>
      <main>
        <div className="cabecera">
          <div>
            <h2>{pagina.titulo}</h2>
            <p>{pagina.desc}</p>
          </div>
          {pagina.conRango && <SelectorRango rango={rango} preset={preset} onCambio={cambiarRango} />}
        </div>
        <Comp rango={rango} />
      </main>
    </div>
  );
}
