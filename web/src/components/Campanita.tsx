import { useEffect, useRef, useState } from 'react';
import { enviarJson, getJson } from '../api';
import { useAcceso } from '../acceso';
import { fechaHora } from '../format';

// Alertas operativas en la cabecera de todas las pantallas (Etapa 2). Reemplaza los avisos dentro de las pantallas:
// German no quiere banners; la campana muestra cuántas hay sin revisar y, al abrirla, cuáles y dónde investigarlas.

interface AlertaCliente {
  alerta: string;
  clave: string;
  severidad: 'alta' | 'media';
  titulo: string;
  detalle: string;
  enlace: string;
  revisada: { por: string; at: string } | null;
}

export function IconoCampana() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export default function Campanita({ conteo, onCambio }: { conteo: { n: number; altas: number } | null; onCambio: () => void }) {
  const { yo, puede } = useAcceso();
  const [abierta, setAbierta] = useState(false);
  const [lista, setLista] = useState<AlertaCliente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const caja = useRef<HTMLDivElement>(null);
  const detalle = puede('alertas.panel');
  const revisar = puede('alertas.revisar');
  const verPagina = (enlace: string) => yo?.paginas[enlace.replace(/^#\/?/, '').split('?')[0]]?.estado === 'ok';

  const cargar = () => {
    if (!detalle) return;
    getJson<{ activas: AlertaCliente[] }>('/api/alertas')
      .then((d) => (setLista(d.activas), setError(null)))
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    if (abierta) cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierta]);

  // Cerrar al hacer clic fuera o con Escape.
  useEffect(() => {
    if (!abierta) return;
    const fuera = (e: MouseEvent) => caja.current && !caja.current.contains(e.target as Node) && setAbierta(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setAbierta(false);
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', fuera);
      document.removeEventListener('keydown', esc);
    };
  }, [abierta]);

  const marcar = async (a: AlertaCliente, revisada: boolean) => {
    await enviarJson('POST', '/api/alertas/revisar', { clave: a.clave, revisada });
    cargar();
    onCambio();
  };

  const n = conteo?.n ?? 0;
  return (
    <div className="campanita" ref={caja}>
      <button
        className={`boton-campana${n ? ' con-alertas' : ''}`}
        onClick={() => setAbierta((v) => !v)}
        aria-expanded={abierta}
        aria-label={n ? `${n} alertas sin revisar` : 'Alertas: ninguna pendiente'}
        title={n ? `${n} alertas sin revisar` : 'Sin alertas pendientes'}
      >
        <IconoCampana />
        {n > 0 && <span className={`insignia${conteo?.altas ? '' : ' insignia-media'}`}>{n}</span>}
      </button>
      {abierta && (
        <div className="campanita-panel" role="dialog" aria-label="Alertas">
          <div className="campanita-titulo">Alertas</div>
          {!detalle ? (
            <div className="campanita-vacia">
              {n ? `Hay ${n} ${n === 1 ? 'alerta activa' : 'alertas activas'}.` : 'No hay alertas activas.'} El detalle de cada alerta, con lo que
              conviene revisar, está disponible en el plan {yo?.niveles[yo.funciones['alertas.panel']?.nivel ?? 'intermedio']}.
              {yo?.paginas.plan?.estado === 'ok' && (
                <div style={{ marginTop: 8 }}>
                  <a className="boton" href="#/plan" onClick={() => setAbierta(false)}>Ver planes</a>
                </div>
              )}
            </div>
          ) : error ? (
            <div className="error">{error}</div>
          ) : !lista ? (
            <div className="campanita-vacia">Cargando…</div>
          ) : !lista.length ? (
            <div className="campanita-vacia">
              <span className="punto-inline" style={{ background: 'var(--good)' }} />
              Todo en orden: no hay alertas activas.
            </div>
          ) : (
            <ul className="campanita-lista">
              {lista.map((a) => (
                <li key={a.clave} className={a.revisada ? 'revisada' : ''}>
                  <span className="punto-inline" style={{ background: a.severidad === 'alta' ? 'var(--critical)' : 'var(--warning)' }} />
                  <div>
                    <div className="campanita-alerta">{a.titulo}</div>
                    <div className="nota" style={{ margin: '2px 0 4px' }}>{a.detalle}</div>
                    {a.revisada && <div className="nota" style={{ margin: '0 0 4px' }}>Revisada por {a.revisada.por} · {fechaHora(a.revisada.at)}</div>}
                    <div className="campanita-acciones">
                      {verPagina(a.enlace) && <a href={a.enlace} onClick={() => setAbierta(false)}>Investigar</a>}
                      {revisar && (a.revisada ? (
                        <button className="enlace" onClick={() => marcar(a, false)}>Marcar pendiente</button>
                      ) : (
                        <button className="enlace" onClick={() => marcar(a, true)}>Marcar revisada</button>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {detalle && yo?.paginas.alertas?.estado === 'ok' && (
            <a className="campanita-pie" href="#/alertas" onClick={() => setAbierta(false)}>Ver la pantalla de Alertas</a>
          )}
        </div>
      )}
    </div>
  );
}
