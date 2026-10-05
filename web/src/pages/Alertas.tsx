import { useCallback, useState } from 'react';
import { conRango, enviarJson, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { pequenosMultiplos } from '../components/series';
import { Estado, Tarjeta } from '../components/ui';
import { rangoAnterior, useSombras, type Incidente } from '../incidentes';
import { fecha, fechaHora } from '../format';
import { MedidorConfianza, type Confianza } from '../components/sala';
import { Esqueleto } from '../components/ui';
import Sistema from './Sistema';
import { CalendarioEjecuciones } from './CampanasEfecto';
import { Bloqueado, useAcceso } from '../acceso';

interface Alerta {
  alerta: string;
  clave: string;
  severidad: 'alta' | 'media';
  titulo: string;
  detalle: string;
  enlace: string;
  revisada: { por: string; at: string } | null;
}
interface Salud {
  dias: { fecha: string; envios: number; pct_fallo: number | null; sesiones: number; citas_registradas: number; citas_actualizadas: number; errores: number }[];
}

const ESTILO: Record<Alerta['severidad'], { color: string; icono: string; texto: string }> = {
  alta: { color: 'var(--critical)', icono: '✕', texto: 'Urgente' },
  media: { color: 'var(--warning)', icono: '!', texto: 'Revisar' },
};

const AREA: Record<string, string> = {
  general: 'General',
  agenda: 'Agenda (Globho)',
  whatsapp: 'Campañas de WhatsApp',
  conversaciones: 'Conversaciones del bot',
  eventos: 'Registro del bot',
  trazabilidad: 'Registro de envíos',
};

function TarjetaAlerta({ a, onCambio }: { a: Alerta; onCambio: () => void }) {
  const e = ESTILO[a.severidad];
  const { yo, puede } = useAcceso();
  const [ocupado, setOcupado] = useState(false);
  const pagina = a.enlace.replace(/^#\/?/, '').split('?')[0];
  const marcar = async (revisada: boolean) => {
    setOcupado(true);
    try {
      await enviarJson('POST', '/api/alertas/revisar', { clave: a.clave, revisada });
      onCambio();
    } finally {
      setOcupado(false);
    }
  };
  return (
    <div className={`kpi${a.revisada ? ' alerta-revisada' : ''}`} style={{ borderLeft: `4px solid ${e.color}` }}>
      <div className="estado" style={{ marginBottom: 4 }}>
        <span className="punto" style={{ background: e.color }} />
        <span>{a.revisada ? '✓ Revisada' : `${e.icono} ${e.texto}`}</span>
      </div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{a.titulo}</div>
      <div className="delta">{a.detalle}</div>
      {a.revisada && <div className="delta" style={{ marginTop: 4 }}>Revisada por {a.revisada.por} · {fechaHora(a.revisada.at)}</div>}
      <div className="campanita-acciones" style={{ marginTop: 8 }}>
        {pagina !== 'alertas' && yo?.paginas[pagina]?.estado === 'ok' && <a href={a.enlace}>Investigar</a>}
        {puede('alertas.revisar') && (
          <button className="enlace" disabled={ocupado} onClick={() => marcar(!a.revisada)}>{a.revisada ? 'Marcar pendiente' : 'Marcar revisada'}</button>
        )}
      </div>
    </div>
  );
}

/** Si el período elegido o su período de comparación tocan un incidente, se explica aquí (y no en cada pantalla). */
function NotaPeriodo({ rango, incidentes }: { rango: Rango; incidentes: Incidente[] }) {
  const prev = rangoAnterior(rango);
  const toca = (r: Rango) => incidentes.filter((i) => i.area !== 'trazabilidad' && i.desde <= r.hasta && i.hasta >= r.desde);
  const enActual = toca(rango);
  const enPrev = toca(prev);
  if (!enActual.length && !enPrev.length) return <p className="ayuda">El período elegido no tiene incidentes de datos conocidos.</p>;
  return (
    <ul className="lista-simple">
      {enActual.length > 0 && (
        <li style={{ display: 'block' }}>
          <div>El período elegido ({fecha(rango.desde)} a {fecha(rango.hasta)}) incluye días con datos incompletos; en los gráficos aparecen sombreados.</div>
        </li>
      )}
      {enPrev.length > 0 && (
        <li style={{ display: 'block' }}>
          <div>
            El período anterior ({fecha(prev.desde)} a {fecha(prev.hasta)}) cae en un incidente: en el Resumen, las comparaciones se hacen contra el mismo período del año
            anterior cuando es posible, o se omiten.
          </div>
        </li>
      )}
    </ul>
  );
}

export default function Alertas({ rango }: { rango: Rango }) {
  const { puede } = useAcceso();
  if (!puede('alertas.panel')) return <Bloqueado clave="alertas.panel" titulo="Alertas operativas y salud de los datos" alto={320} />;
  return <AlertasPanel rango={rango} />;
}

function AlertasPanel({ rango }: { rango: Rango }) {
  const { puede } = useAcceso();
  const { data, error, cargando, recargar } = useApi<{ activas: Alerta[]; incidentes: Incidente[] }>('/api/alertas', 60_000);
  const conf = useApi<Confianza>(puede('confianza') ? conRango('/api/confianza', rango) : null, 300_000);
  const salud = useApi<Salud>(conRango('/api/alertas/salud', rango), 300_000);
  const sombras = useSombras(['general']);

  // SIS-02: cinco series diarias con su propia escala; un hueco o un salto se ve a simple vista.
  const optSalud = useCallback(() => {
    const d = salud.data!.dias;
    return pequenosMultiplos(
      d.map((x) => x.fecha),
      {
        'Mensajes de campaña enviados': d.map((x) => x.envios),
        'Envíos fallidos (%)': d.map((x) => x.pct_fallo),
        'Conversaciones del bot': d.map((x) => x.sesiones),
        'Citas nuevas desde Globho': d.map((x) => x.citas_registradas),
        'Errores del bot': d.map((x) => x.errores),
      },
      'day',
      sombras,
    );
  }, [salud.data, sombras]);

  return (
    <>
      {puede('confianza') && (
        <Tarjeta
          titulo="Confianza de los datos del período"
          ayuda="Combina qué tan al día están la agenda, el bot y las campañas, la calidad de teléfonos y profesionales, y los incidentes conocidos. Cada punto bajo 90 % indica dónde revisar."
        >
          {conf.data ? <MedidorConfianza c={conf.data} detalle /> : conf.error ? <div className="error">{conf.error}</div> : <Esqueleto forma="bloque" />}
        </Tarjeta>
      )}
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tarjeta
            titulo={data.activas.length ? `Alertas activas (${data.activas.length})` : 'Alertas activas'}
            ayuda="Se revisan cada minuto: campañas que no corrieron o no enviaron, envíos rechazados por WhatsApp, agenda sin sincronizar, bot sin conversaciones y picos de errores."
          >
            {data.activas.length ? (
              <div className="kpis" style={{ marginBottom: 0 }}>
                {data.activas.map((a) => (
                  <TarjetaAlerta key={a.clave} a={a} onCambio={recargar} />
                ))}
              </div>
            ) : (
              <div className="estado">
                <span className="punto" style={{ background: 'var(--good)' }} />✓ Todo funcionando: no hay alertas activas.
              </div>
            )}
          </Tarjeta>

          <Tarjeta titulo="Avisos sobre los datos" ayuda="Períodos en que el sistema no registró bien la información. Las cifras de esos días están incompletas.">
            <ul className="lista-simple">
              {data.incidentes.map((i, k) => (
                <li key={k} style={{ display: 'block' }}>
                  <div style={{ fontWeight: 600 }}>
                    {i.titulo} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {AREA[i.area] ?? i.area}</span>
                  </div>
                  <div className="ayuda" style={{ margin: '2px 0 0' }}>
                    {fecha(i.desde)} a {fecha(i.hasta)}. {i.descripcion}
                  </div>
                </li>
              ))}
            </ul>
            <h4 style={{ margin: '16px 0 6px', fontSize: 13 }}>Sobre el período que está viendo</h4>
            <NotaPeriodo rango={rango} incidentes={data.incidentes} />
          </Tarjeta>
        </>
      )}

      {puede('campanas.ejecuciones') && (
        <Tarjeta titulo="Ejecuciones de las campañas" ayuda="Cada cuadro es una campaña en un día. Pase el cursor para ver cuántas citas procesó y cuántos mensajes envió.">
          <CalendarioEjecuciones rango={rango} />
        </Tarjeta>
      )}

      <Tarjeta titulo="Salud diaria de los datos" ayuda="Si una de estas líneas cae a cero sin motivo, algo dejó de funcionar. Los días con incidentes conocidos aparecen sombreados.">
        <Estado cargando={salud.cargando} error={salud.error} hayDatos={!!salud.data} />
        {salud.data && <Grafico opcion={optSalud} alto={520} />}
      </Tarjeta>

      <h3 style={{ margin: '24px 0 12px' }}>Estado de los servicios</h3>
      <Sistema />
    </>
  );
}
