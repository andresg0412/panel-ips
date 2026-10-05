import { conRango, useApi, type Rango } from '../api';
import { ListaConteo, Tarjeta } from '../components/ui';
import { fecha, num, pct } from '../format';

interface Demanda {
  sinConvertir: { clave: string; vieron: number; agendaron: number }[];
  noEntendidos: { no_entendidos: number; entrantes: number; desde: string | null };
  porPaso: { clave: string; n: number }[];
}

/** 'agendar.s08_fechas' → 'Agendar: fechas' */
function nombrePaso(p: string): string {
  const [flujo, resto = ''] = p.split('.');
  const paso = resto.replace(/^[a-z]+\d+_/, '').replace(/_/g, ' ');
  const f = flujo.replace(/_/g, ' ');
  return paso ? `${f.charAt(0).toUpperCase() + f.slice(1)}: ${paso}` : f;
}

/** CHB-02 (demanda que el bot no convierte) y CHB-03 (mensajes que no entendió). Datos desde el 30-sep-2026. */
export function DemandaChatbot({ rango }: { rango: Rango }) {
  const { data } = useApi<Demanda>(conRango('/api/chatbot/demanda', rango), 120_000);
  if (!data) return null;
  const vieron = data.sinConvertir.reduce((s, x) => s + x.vieron, 0);
  const agendaron = data.sinConvertir.reduce((s, x) => s + x.agendaron, 0);
  const porEspecialidad = data.sinConvertir.filter((x) => x.clave !== 'Sin dato');
  const ne = data.noEntendidos;
  return (
    <div className="grid g2">
      <Tarjeta
        titulo="Demanda que el bot no convierte"
        ayuda="Personas que consultaron fechas u horas disponibles para agendar y no terminaron con una cita. Datos detallados desde el 30 sep 2026."
      >
        {vieron ? (
          <>
            <div className="cifras">
              <div className="cifra">
                <div className="n">{num(vieron - agendaron)}</div>
                <div className="t">consultaron disponibilidad y no agendaron</div>
              </div>
              <div className="cifra">
                <div className="n">{pct(agendaron, vieron, 0)}</div>
                <div className="t">de quienes vieron fechas terminaron agendando</div>
              </div>
            </div>
            {porEspecialidad.length > 0 && (
              <ListaConteo items={porEspecialidad.map((x) => ({ clave: x.clave, etiqueta: x.clave, n: x.vieron - x.agendaron }))} />
            )}
            <p className="nota">Es demanda real que se pierde: candidatos para una llamada de recepción o para la lista de espera.</p>
          </>
        ) : (
          <p className="ayuda">Sin consultas de disponibilidad registradas en el período.</p>
        )}
      </Tarjeta>
      <Tarjeta
        titulo="Mensajes que el bot no entendió"
        ayuda={`Respuestas que el bot no supo interpretar (por ejemplo, texto libre donde esperaba un botón).${ne.desde ? ` Datos desde el ${fecha(ne.desde)}.` : ''}`}
      >
        {ne.entrantes ? (
          <>
            <div className="cifras">
              <div className="cifra">
                <div className="n">{pct(ne.no_entendidos, ne.entrantes, 1)}</div>
                <div className="t">de los mensajes recibidos ({num(ne.no_entendidos)} de {num(ne.entrantes)})</div>
              </div>
            </div>
            {data.porPaso.length > 0 && (
              <>
                <p className="ayuda" style={{ marginTop: 12 }}>Dónde ocurre más:</p>
                <ListaConteo items={data.porPaso.map((p) => ({ clave: p.clave, etiqueta: nombrePaso(p.clave), n: p.n }))} total={ne.no_entendidos} />
              </>
            )}
          </>
        ) : (
          <p className="ayuda">Sin mensajes registrados en el período.</p>
        )}
      </Tarjeta>
    </div>
  );
}
