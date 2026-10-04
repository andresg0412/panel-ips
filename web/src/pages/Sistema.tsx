import { useApi } from '../api';
import { Estado, Tabla, Tarjeta, type Columna } from '../components/ui';
import { etiqueta, fecha, fechaHora, haceCuanto, minutosDesde, num } from '../format';

interface Datos {
  actividad: {
    ultimo_evento_bot: string | null;
    eventos_24h: number;
    ultima_actualizacion_agenda: string | null;
    ultima_conversacion: string | null;
    ahora: string;
  };
  campanas: { campana: string; ultimo_envio: string | null; envios_hoy: number; fallidos_hoy: number }[];
  erroresEnvio: { error: string; error_code: string | null; n: number; ultima_vez: string }[];
  erroresBot: { tipo_evento: string; detalle: string; n: number; ultima_vez: string }[];
}

type Nivel = 'ok' | 'atencion' | 'problema';
const COLOR: Record<Nivel, string> = { ok: 'var(--good)', atencion: 'var(--warning)', problema: 'var(--critical)' };
const TEXTO: Record<Nivel, string> = { ok: '✓ Funcionando', atencion: '! Revisar', problema: '✕ Sin actividad' };

/** De noche y los domingos es normal que no haya actividad: se tolera más tiempo sin eventos. */
function horarioLaboral(ahora: string): boolean {
  const d = new Date(`${ahora}Z`);
  const h = d.getUTCHours();
  return d.getUTCDay() !== 0 && h >= 7 && h < 20;
}

function nivel(min: number | null, limiteAtencion: number, limiteProblema: number): Nivel {
  if (min === null || min > limiteProblema) return 'problema';
  return min > limiteAtencion ? 'atencion' : 'ok';
}

function Semaforo({ titulo, desc, n, detalle }: { titulo: string; desc: string; n: Nivel; detalle: string }) {
  return (
    <div className="kpi">
      <div className="etiqueta">{titulo}</div>
      <div className="estado" style={{ margin: '6px 0' }}>
        <span className="punto" style={{ background: COLOR[n] }} />
        {TEXTO[n]}
      </div>
      <div className="delta">{detalle}</div>
      <div className="delta">{desc}</div>
    </div>
  );
}

const COLS_CAMP: Columna<Datos['campanas'][number]>[] = [
  { clave: 'campana', titulo: 'Campaña', formato: etiqueta },
  { clave: 'ultimo_envio', titulo: 'Último envío', formato: fechaHora },
  { clave: 'envios_hoy', titulo: 'Enviados hoy', num: true },
  { clave: 'fallidos_hoy', titulo: 'Fallidos hoy', num: true },
];
const COLS_ERR: Columna<Datos['erroresEnvio'][number]>[] = [
  { clave: 'error', titulo: 'Error de WhatsApp' },
  { clave: 'error_code', titulo: 'Código' },
  { clave: 'n', titulo: 'Veces', num: true },
  { clave: 'ultima_vez', titulo: 'Última vez', formato: fecha },
];
const COLS_BOT: Columna<Datos['erroresBot'][number]>[] = [
  { clave: 'tipo_evento', titulo: 'Tipo', formato: etiqueta },
  { clave: 'detalle', titulo: 'Detalle' },
  { clave: 'n', titulo: 'Veces', num: true },
  { clave: 'ultima_vez', titulo: 'Última vez', formato: fechaHora },
];

export default function Sistema() {
  const { data, error, cargando } = useApi<Datos>('/api/sistema', 30_000);
  const a = data?.actividad;
  const laboral = a ? horarioLaboral(a.ahora) : true;
  const minBot = a ? minutosDesde(a.ultimo_evento_bot, a.ahora) : null;
  const minAgenda = a ? minutosDesde(a.ultima_actualizacion_agenda, a.ahora) : null;

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && a && (
        <>
          <div className="kpis">
            <Semaforo
              titulo="Bot de WhatsApp"
              n={laboral ? nivel(minBot, 120, 360) : nivel(minBot, 720, 2880)}
              detalle={`Última actividad ${haceCuanto(minBot)} · ${num(a.eventos_24h)} eventos en 24 h`}
              desc="Mensajes, conversaciones y campañas registradas."
            />
            <Semaforo
              titulo="Sincronización con Globho"
              n={laboral ? nivel(minAgenda, 180, 480) : nivel(minAgenda, 1440, 4320)}
              detalle={`Último cambio de agenda ${haceCuanto(minAgenda)}`}
              desc="Las citas se copian de Globho cada hora en horario laboral."
            />
            <Semaforo titulo="Panel" n="ok" detalle="Conectado a la base de datos" desc={`Hora del servidor: ${fechaHora(a.ahora)}`} />
          </div>
          <Tarjeta titulo="Campañas automáticas" ayuda="Último envío de cada campaña (últimos 60 días).">
            <Tabla filas={data.campanas} columnas={COLS_CAMP} />
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Errores de envío (últimos 7 días)">
              <Tabla filas={data.erroresEnvio} columnas={COLS_ERR} vacio="Sin errores de envío" />
            </Tarjeta>
            <Tarjeta titulo="Errores del bot (últimos 7 días)">
              <Tabla filas={data.erroresBot} columnas={COLS_BOT} vacio="Sin errores registrados" />
            </Tarjeta>
          </div>
        </>
      )}
    </>
  );
}
