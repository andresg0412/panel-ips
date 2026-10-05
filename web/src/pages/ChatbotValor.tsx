// Etapa 3 · Chatbot, pestaña "Lo que aporta el bot": embudo de las conversaciones, horas de recepción ahorradas
// (con los minutos por trámite editables) y oportunidades de mejora en frases.
import { useCallback, useState } from 'react';
import { conRango, enviarJson, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas } from '../components/series';
import { EmbudoEtapas } from '../components/embudo';
import { ListaFrases, type Frase } from '../components/sala';
import { Estado, Info, Tarjeta } from '../components/ui';
import { Restringido, useAcceso } from '../acceso';
import { useMarcas, useSombras } from '../incidentes';
import { fecha, fechaHora, num, pct } from '../format';

// ------------------------------------------------------------------------------------------- embudo
interface Historia {
  embudo: {
    conversaciones: number;
    con_tramite: number;
    completadas: number;
    derivadas: number;
    derivadas_fuera_horario: number;
    abandonadas: number;
    abandonadas_inicio: number;
    fuera_horario: number;
    completadas_fuera_horario: number;
    agendadas: number;
    canceladas: number;
    reprogramadas: number;
    confirmaciones: number;
  };
}

function EmbudoConversaciones({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Historia>(conRango('/api/chatbot/historia', rango), 120_000);
  const { puede } = useAcceso();
  const demanda = useApi<{ noEntendidos: { no_entendidos: number; entrantes: number; desde: string | null } }>(
    puede('chatbot.demanda') ? conRango('/api/chatbot/demanda', rango) : null,
    120_000,
  );
  const marcas = useMarcas(rango, ['conversaciones', 'eventos']);
  const e = data?.embudo;
  const ne = demanda.data?.noEntendidos;
  const terminadas = e ? e.completadas + e.derivadas : 0;

  return (
    <Tarjeta
      titulo="Del saludo al trámite resuelto"
      marcas={marcas}
      ayuda="Cuántas conversaciones llegan a un trámite y cuántas el bot resuelve solo, sin que intervenga recepción."
    >
      <Estado cargando={cargando} error={error} hayDatos={!!data} forma="bloque" />
      {e && (e.conversaciones === 0 ? (
        <p className="vacio">Sin conversaciones en el período.</p>
      ) : (
        <>
          <EmbudoEtapas
            etapas={[
              { nombre: 'Conversaciones', valor: e.conversaciones, definicion: 'Conversaciones iniciadas con el bot en el período.' },
              {
                nombre: 'El bot identificó el trámite',
                valor: e.con_tramite,
                definicion: 'La persona llegó a un trámite concreto: agendar, cancelar, reprogramar, responder a un recordatorio, lista de espera, información o un asesor.',
              },
              {
                nombre: 'Resuelto por el bot',
                valor: e.completadas,
                definicion: 'Terminó con una cita creada, cancelada, reprogramada o confirmada, sin pasar por recepción.',
              },
            ]}
            pie={
              <div className="embudo-rama">
                <EmbudoEtapas
                  base={e.conversaciones}
                  etapas={[
                    {
                      nombre: 'Pasaron a un asesor',
                      valor: e.derivadas,
                      definicion: 'Pidieron hablar con una persona. Incluye a quienes lo pidieron fuera de horario.',
                    },
                  ]}
                />
              </div>
            }
          />
          <div className="cifras" style={{ marginTop: 16 }}>
            <div className="cifra">
              <div className="n">{pct(e.completadas, terminadas, 0)}</div>
              <div className="t">
                sin intervención humana <Info texto="De los trámites que terminaron (resueltos por el bot o pasados a un asesor), los que el bot resolvió solo." />
              </div>
            </div>
            <div className="cifra">
              <div className="n">{num(e.completadas_fuera_horario)}</div>
              <div className="t">trámites resueltos fuera del horario de recepción ({pct(e.fuera_horario, e.conversaciones, 0)} de las conversaciones llega fuera de horario)</div>
            </div>
            <div className="cifra">
              <div className="n">{pct(e.abandonadas, e.conversaciones, 0)}</div>
              <div className="t">de las conversaciones se abandona sin terminar</div>
            </div>
            {ne && ne.entrantes > 0 && (
              <div className="cifra">
                <div className="n">{pct(ne.no_entendidos, ne.entrantes, 1)}</div>
                <div className="t">de los mensajes no los entendió el bot{ne.desde ? ` (desde el ${fecha(ne.desde)})` : ''}</div>
              </div>
            )}
          </div>
        </>
      ))}
    </Tarjeta>
  );
}

// ------------------------------------------------------------------------------------------- ahorro
interface Parametro {
  titulo: string;
  unidad: string;
  defecto: number;
  min: number;
  max: number;
  valor: number;
  actualizado_por: string | null;
  actualizado_at: string | null;
}
interface Conteo {
  agendadas: number;
  reprogramadas: number;
  canceladas: number;
  confirmadas: number;
}
interface Ahorro {
  grano: 'week' | 'month';
  tramites: Conteo;
  minutos: Conteo;
  horas: number;
  serie: (Conteo & { periodo: string; horas: number })[];
  duraciones: { resultado: string; n: number; mediana_min: number | null }[];
  fueraHorario: number;
  parametros: Record<string, Parametro>;
  editable: boolean;
}

const FILAS: { clave: keyof Conteo; param: string; nombre: string }[] = [
  { clave: 'confirmadas', param: 'min_confirmar', nombre: 'Citas confirmadas' },
  { clave: 'agendadas', param: 'min_agendar', nombre: 'Citas agendadas' },
  { clave: 'canceladas', param: 'min_cancelar', nombre: 'Citas canceladas' },
  { clave: 'reprogramadas', param: 'min_reprogramar', nombre: 'Citas reprogramadas' },
];

const DURACION: Record<string, { nombre: string; param: string }> = {
  cita_creada: { nombre: 'Agendar', param: 'min_agendar' },
  cita_cancelada: { nombre: 'Cancelar', param: 'min_cancelar' },
  cita_reprogramada: { nombre: 'Reprogramar', param: 'min_reprogramar' },
  cita_confirmada: { nombre: 'Confirmar', param: 'min_confirmar' },
};

const horasTxt = (h: number) => (h < 10 ? h.toFixed(1).replace('.', ',') : num(Math.round(h)));
const minTxt = (m: number) => `${String(m).replace('.', ',')} min`;

function EditorMinutos({ parametros, onCambio, onCerrar }: { parametros: Record<string, Parametro>; onCambio: () => void; onCerrar: () => void }) {
  const [valores, setValores] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(parametros).map(([k, p]) => [k, String(p.valor)])));
  const [msg, setMsg] = useState<string | null>(null);
  const guardar = async (k: string, referencia = false) => {
    const p = parametros[k];
    const v = referencia ? null : Number((valores[k] ?? '').replace(',', '.'));
    if (v !== null && (!Number.isFinite(v) || v < p.min || v > p.max)) {
      setMsg(`${p.titulo}: entre ${p.min} y ${p.max} minutos`);
      return;
    }
    try {
      await enviarJson('PUT', '/api/parametros', { clave: k, valor: v });
      if (referencia) setValores((x) => ({ ...x, [k]: String(p.defecto) }));
      setMsg(`${p.titulo}: guardado`);
      onCambio();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    }
  };
  return (
    <div className="editor-metas" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <strong style={{ fontSize: 13.5 }}>Minutos que tomaría cada trámite por teléfono</strong>
        <button className="boton" onClick={onCerrar}>Cerrar</button>
      </div>
      <div className="tabla-wrap" style={{ marginTop: 8 }}>
        <table>
          <thead>
            <tr><th>Trámite</th><th>Minutos</th><th>Referencia</th><th>Último cambio</th><th /></tr>
          </thead>
          <tbody>
            {Object.entries(parametros).map(([k, p]) => (
              <tr key={k}>
                <td>{p.titulo}</td>
                <td>
                  <input className="boton" inputMode="decimal" style={{ width: 70 }} value={valores[k] ?? ''} onChange={(e) => setValores({ ...valores, [k]: e.target.value })} aria-label={`Minutos: ${p.titulo}`} />
                </td>
                <td>{p.defecto} min</td>
                <td>{p.actualizado_at ? `${fechaHora(p.actualizado_at)} · ${p.actualizado_por ?? ''}` : '—'}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="boton" onClick={() => guardar(k)}>Guardar</button>
                  {p.actualizado_at && <button className="boton" onClick={() => guardar(k, true)}>Usar referencia</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <p className="nota">{msg}</p>}
    </div>
  );
}

function HorasAhorradas({ rango }: { rango: Rango }) {
  const { data, error, cargando, recargar } = useApi<Ahorro>(conRango('/api/chatbot/ahorro', rango), 300_000);
  const [editando, setEditando] = useState(false);
  const marcasInc = useMarcas(rango, ['conversaciones', 'whatsapp']);
  const sombras = useSombras(['conversaciones', 'whatsapp']);

  const opt = useCallback(() => {
    const s = data!.serie;
    const p = data!.parametros;
    const periodos = s.map((x) => (data!.grano === 'month' ? x.periodo.slice(0, 7) : x.periodo));
    const h = (k: keyof Conteo, param: string) => s.map((x) => Math.round(((x[k] * p[param].valor) / 60) * 10) / 10);
    const o = barrasApiladas(
      periodos,
      Object.fromEntries(FILAS.map((f) => [f.nombre, h(f.clave, f.param)])),
      data!.grano,
      sombras,
    ) as any;
    o.tooltip.valueFormatter = (v: number) => `${String(v).replace('.', ',')} h`;
    return o;
  }, [data, sombras]);

  const supuesto = data
    ? `Supone ${FILAS.map((f) => `${data.parametros[f.param].valor} min por ${data.parametros[f.param].titulo.charAt(0).toLowerCase()}${data.parametros[f.param].titulo.slice(1)}`).join(', ')}.`
    : '';
  const duraciones = (data?.duraciones ?? []).filter((d) => d.n >= 5 && d.mediana_min !== null && DURACION[d.resultado]);

  return (
    <Tarjeta
      titulo="¿Cuánto trabajo le ahorra el bot a recepción?"
      marcas={[{ tipo: 'estimada', detalle: `Trámites resueltos por WhatsApp multiplicados por los minutos que tomaría cada uno por teléfono. ${supuesto}` }, ...marcasInc]}
      ayuda="Trámites que el bot resolvió sin recepción, convertidos en horas de trabajo según cuánto toma cada uno por teléfono."
      accion={data?.editable && !editando ? <button className="boton" onClick={() => setEditando(true)}>Ajustar minutos</button> : undefined}
    >
      <Estado cargando={cargando} error={error} hayDatos={!!data} forma="bloque" />
      {data && (
        <>
          <div className="ahorro-cabeza">
            <div>
              <div className="ahorro-horas">
                {horasTxt(data.horas)}
                <small>horas de recepción</small>
              </div>
              <div className="nota" style={{ marginTop: 4 }}>
                equivalen a {String(Math.round((data.horas / 8) * 10) / 10).replace('.', ',')} jornadas de 8 horas
              </div>
            </div>
            {data.fueraHorario > 0 && (
              <div className="cifra">
                <div className="n">{num(data.fueraHorario)}</div>
                <div className="t">trámites resueltos cuando recepción estaba cerrada</div>
              </div>
            )}
          </div>
          <div className="grid g2">
            <div>
              <ul className="lista-simple">
                {FILAS.map((f) => (
                  <li key={f.clave}>
                    <span>
                      {f.nombre}: {num(data.tramites[f.clave])} × {minTxt(data.parametros[f.param].valor)}
                    </span>
                    <span>{horasTxt(data.minutos[f.clave] / 60)} h</span>
                  </li>
                ))}
              </ul>
              {duraciones.length > 0 && (
                <>
                  <p className="ayuda" style={{ margin: '14px 0 6px' }}>
                    Con el bot, el paciente lo resuelve en (tiempo típico de la conversación):
                  </p>
                  <ul className="lista-simple">
                    {duraciones.map((d) => (
                      <li key={d.resultado}>
                        <span>
                          {DURACION[d.resultado].nombre} <span className="nota">· {num(d.n)} casos</span>
                        </span>
                        <span>
                          {minTxt(d.mediana_min!)} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>vs {minTxt(data.parametros[DURACION[d.resultado].param].valor)} por teléfono</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div>{data.serie.length > 1 ? <Grafico opcion={opt} alto={230} /> : null}</div>
          </div>
          {editando && <EditorMinutos parametros={data.parametros} onCambio={recargar} onCerrar={() => setEditando(false)} />}
        </>
      )}
    </Tarjeta>
  );
}

// ---------------------------------------------------------------------------------------- oportunidades
function Oportunidades({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<{ frases: Frase[]; omitidas: string | null }>(conRango('/api/chatbot/oportunidades', rango), 300_000);
  return (
    <Tarjeta
      titulo="Oportunidades de mejora"
      ayuda="Dónde se pierden las conversaciones y qué demanda queda sin atender, ordenado por cuántas personas afecta. Cada frase enlaza al detalle."
    >
      <Estado cargando={cargando} error={error} hayDatos={!!data} forma="bloque" />
      {data &&
        (data.omitidas ? (
          <p className="vacio">{data.omitidas} Elija otro período para ver las oportunidades de mejora.</p>
        ) : data.frases.length ? (
          <ListaFrases frases={data.frases} />
        ) : (
          <p className="vacio">No se ven puntos de abandono destacables en este período.</p>
        ))}
    </Tarjeta>
  );
}

export default function ChatbotValor({ rango }: { rango: Rango }) {
  return (
    <>
      <Restringido clave="chatbot.historia" titulo="Del saludo al trámite resuelto">
        <EmbudoConversaciones rango={rango} />
      </Restringido>
      <Restringido clave="chatbot.ahorro" titulo="¿Cuánto trabajo le ahorra el bot a recepción?">
        <HorasAhorradas rango={rango} />
      </Restringido>
      <Restringido clave="chatbot.oportunidades" titulo="Oportunidades de mejora">
        <Oportunidades rango={rango} />
      </Restringido>
    </>
  );
}
