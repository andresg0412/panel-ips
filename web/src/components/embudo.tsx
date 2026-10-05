// Embudo por etapas (Etapa 3): valor absoluto, porcentaje sobre la primera etapa y caída frente a la etapa
// anterior. Una etapa sin dato en el período se ve punteada con "dato disponible desde…" y no corta la cadena:
// la siguiente se compara con la última etapa que sí tiene dato.
import type { ReactNode } from 'react';
import { num } from '../format';
import { Info, Marca } from './ui';

export interface Etapa {
  nombre: string;
  /** null = sin dato en el período (se muestra `nota`). */
  valor: number | null;
  /** Definición de la etapa (en la "i"). */
  definicion?: string;
  /** La etapa se calcula con un enlace inferido: barra rayada y distintivo. */
  estimada?: boolean;
  /** Texto en lugar de las cifras cuando no hay dato. */
  nota?: string;
  /**
   * La etapa no sirve de base a la siguiente (p. ej. "leídos": WhatsApp solo informa la lectura si la persona
   * tiene activadas las confirmaciones, así que responden más de los que aparecen como leídos).
   */
  noComparar?: boolean;
}

const porc = (v: number) => `${Math.round(v * 100)} %`;

export function EmbudoEtapas({ etapas, pie, base }: {
  etapas: Etapa[];
  pie?: ReactNode;
  /** Valor que ocupa la barra completa y base de "% del inicio" (por defecto, la primera etapa). */
  base?: number;
}) {
  const inicio = base ?? etapas[0]?.valor ?? 0;
  let anterior: number | null = null;
  return (
    <>
      <ol className="embudo">
        {etapas.map((e, i) => {
          const conDato = e.valor !== null;
          const prev = anterior;
          if (conDato && !e.noComparar) anterior = e.valor;
          const ancho = conDato && inicio > 0 ? Math.max(0.5, (e.valor! / inicio) * 100) : 0;
          const caida = conDato && prev !== null && prev > 0 && i > 0 ? 1 - e.valor! / prev : null;
          return (
            <li key={e.nombre} className={`embudo-etapa${conDato ? '' : ' sin-dato'}${e.estimada ? ' estimada' : ''}`}>
              <span className="embudo-nombre">
                {e.nombre}
                {e.definicion && <Info texto={e.definicion} />}
                {e.estimada && <Marca tipo="estimada" detalle="Enlace inferido entre el mensaje y la cita: por la cita del mensaje o, si no la trae, por el mismo teléfono con una cita en los 6 días siguientes." />}
              </span>
              <span className="embudo-barra" aria-hidden="true">
                <span style={{ width: `${ancho}%` }} />
              </span>
              <span className="embudo-cifras">
                {conDato ? (
                  <>
                    <b>{num(e.valor!)}</b>
                    {(i > 0 || base !== undefined) && inicio > 0 && <span>{porc(e.valor! / inicio)} del inicio</span>}
                    {caida !== null && caida > 0.005 && <span className="embudo-caida">▼ {porc(caida)} frente a la anterior</span>}
                  </>
                ) : (
                  <span>{e.nota ?? 'Sin dato'}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {pie}
    </>
  );
}
