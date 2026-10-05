// Etapa 5 · Informe ejecutivo mensual y resumen semanal. Una página diseñada para imprimir en A4 (o guardar en PDF
// desde el navegador): portada, indicadores con meta y comparación, lo más relevante, detalle y recomendaciones.
// Las cifras salen de los mismos endpoints de cada pantalla, así que coinciden con lo que se ve en el panel.
import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { conRango, registrar, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, pivotar } from '../components/series';
import { EmbudoEtapas } from '../components/embudo';
import { Estado } from '../components/ui';
import { KpiPrincipal, ListaAtencion, ListaFrases, MedidorConfianza, conNegritas, type Confianza, type Frase, type Meta, type MetaKpi } from '../components/sala';
import { IncidentesCtx } from '../incidentes';
import { DIAS, etiqueta, fecha, num, pct, tasaTxt } from '../format';
import { DEF, asistencia, noOcurrio, tramites, type DatosMetas, type DatosResumen, type Sala, type Semana } from './Resumen';
import logo from '../assets/logo-ips.webp';

type Tipo = 'mes' | 'semana';

interface Contexto {
  ips: string;
  hoy: string;
  preparadoPara: string | null;
  meses?: string[];
  semanas?: string[];
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1]} de ${m.slice(0, 4)}`;
const sumar = (f: string, d: number) => new Date(Date.parse(`${f}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const finMes = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

function rangoDe(tipo: Tipo, p: string): Rango {
  return tipo === 'mes' ? { desde: `${p}-01`, hasta: finMes(p) } : { desde: p, hasta: sumar(p, 6) };
}
const tituloPeriodo = (tipo: Tipo, p: string) => (tipo === 'mes' ? nombreMes(p) : `semana del ${fecha(p)} al ${fecha(sumar(p, 6))}`);

// ------------------------------------------------------------------------------------------ tipos
interface Campanas { porCampana: { campana: string; enviados: number; fallidos: number; respondieron: number; respondieron_tarde: number; citas_confirmadas: number }[] }
interface Embudo { etapas: { aceptados: number; entregados: number; leidos: number; respondieron: number; confirmaron: number; confirmaron_y_asistieron: number }; seguimientoDesde: string | null }
interface Historia { embudo: Record<string, number> }
interface Ahorro { horas: number; tramites: Record<string, number>; fueraHorario: number }
interface Capacidad {
  medible: boolean;
  profesionales: { cupos: number; ocupan: number; libres: number }[];
  franjas: { dia: number; hora: number; ofrecidos: number; libres: number }[];
  espera: { especialidad: string; dias: number | null; libres_7d: number }[];
}
interface Cancelaciones { kpis: { total: number; canceladas: number; reprogramadas: number; horas: number }; recolocados: number }
interface Inasistencia { mapa: { dia: number; hora: number; cerradas: number; no_asistio: number }[] }
interface Calidad { telefonos: { sin_telefono_valido: number; no_movil: number } }
interface Fatiga { meses: { numeros: number; g8: number }[] }
interface Series { rango: { grano: string }; citas: { periodo: string; grupo: string | null; n: number }[] }
interface Recuperables { filas: { inscritos: number }[] }

interface Recomendacion {
  clave: string;
  texto: string;
}

// ------------------------------------------------------------------------------------- recomendaciones
/** Recomendaciones del período, por reglas sobre los mismos datos del informe (máximo 5, de la más concreta). */
function recomendar(d: {
  resumen?: DatosResumen;
  metas?: Record<string, Meta>;
  inas?: Inasistencia;
  canc?: Cancelaciones;
  cap?: Capacidad;
  oport?: { frases: Frase[] };
  cal?: Calidad;
  fatiga?: Fatiga;
  recup?: Recuperables;
}): Recomendacion[] {
  const out: Recomendacion[] = [];
  const a = d.resumen?.actual;
  // 1. Asistencia por debajo de la meta: reforzar la franja con más inasistencia.
  const asis = a ? asistencia(a.citas) : null;
  const metaAsis = d.metas?.asistencia?.valor ?? null;
  const peorFranja = (d.inas?.mapa ?? []).filter((c) => c.cerradas >= 30).map((c) => ({ ...c, t: c.no_asistio / c.cerradas })).sort((x, y) => y.t - x.t)[0];
  if (asis !== null && metaAsis !== null && asis < metaAsis) {
    out.push({
      clave: 'asistencia',
      texto: `La asistencia (**${tasaTxt(asis)}**) quedó por debajo de la meta (${tasaTxt(metaAsis, 0)}).${
        peorFranja ? ` Refuerce los recordatorios de las citas del **${DIAS[peorFranja.dia].toLowerCase()} a las ${peorFranja.hora}:00**, la franja con más inasistencia (${tasaTxt(peorFranja.t, 0)}).` : ''
      }`,
    });
  }
  // 2. Cancelaciones altas: recolocar cupos con la lista de espera.
  const k = d.canc?.kpis;
  const inscritos = (d.recup?.filas ?? []).reduce((s, f) => s + f.inscritos, 0);
  if (k && k.total >= 50 && (k.canceladas + k.reprogramadas) / k.total >= 0.2) {
    out.push({
      clave: 'cancelaciones',
      texto: `El **${pct(k.canceladas + k.reprogramadas, k.total, 0)}** de las citas no ocurrió y se liberaron **${num(Math.round(k.horas))} horas** de consulta. ${
        inscritos === 0
          ? 'Hoy no hay pacientes inscritos en la lista de espera: activar la inscripción permitiría ofrecerles esos cupos.'
          : `Hay ${num(inscritos)} pacientes en la lista de espera para ofrecerles cupos liberados.`
      }`,
    });
  }
  // 3. Capacidad sin usar en una franja concreta.
  const franja = (d.cap?.franjas ?? []).filter((c) => c.ofrecidos >= 8 && c.dia <= 6).map((c) => ({ ...c, t: c.libres / c.ofrecidos })).sort((x, y) => y.t - x.t)[0];
  if (franja && franja.t >= 0.35) {
    out.push({
      clave: 'capacidad',
      texto: `Los **${DIAS[franja.dia].toLowerCase()} a las ${franja.hora}:00** quedó sin usar el **${tasaTxt(franja.t, 0)}** de los cupos: es una buena franja para ofrecer citas o ajustar el horario.`,
    });
  }
  // 4. Teléfonos que impiden los recordatorios.
  const tel = d.cal?.telefonos;
  if (tel && tel.sin_telefono_valido + tel.no_movil >= 20) {
    out.push({
      clave: 'telefonos',
      texto: `**${num(tel.sin_telefono_valido + tel.no_movil)} pacientes** no tienen un celular válido y no reciben recordatorios. Corregirlos en Globho mejora la cobertura de las campañas.`,
    });
  }
  // 5. La principal oportunidad de mejora del bot.
  const op = d.oport?.frases?.[0];
  if (op) out.push({ clave: 'bot', texto: `En el bot: ${op.texto.charAt(0).toLowerCase()}${op.texto.slice(1)}` });
  // 6. Demasiados mensajes al mismo número.
  const f = (d.fatiga?.meses ?? []).reduce((s, x) => ({ n: s.n + x.numeros, g8: s.g8 + x.g8 }), { n: 0, g8: 0 });
  if (f.n >= 100 && f.g8 / f.n >= 0.1) {
    out.push({ clave: 'fatiga', texto: `**${num(f.g8)}** veces un número recibió 8 o más mensajes en un mes: conviene revisar la frecuencia de las campañas.` });
  }
  return out.slice(0, 5);
}

// --------------------------------------------------------------------------------------------- hoja
function Hoja({ titulo, children, numero, id }: { titulo?: string; children: ReactNode; numero?: number; id?: string }) {
  return (
    <section className="informe-hoja" id={id}>
      {titulo && <h2 className="informe-h2">{titulo}</h2>}
      {children}
      {numero !== undefined && <div className="informe-pie">Página {numero}</div>}
    </section>
  );
}

/**
 * Entrada del índice: desplaza hasta la sección sin tocar la URL. Un href="#seccion" no sirve aquí porque el
 * panel usa el hash como ruta (#/pantalla) y el clic llevaría a la pantalla de inicio.
 */
function IrA({ id, children }: { id: string; children: ReactNode }) {
  return <button type="button" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{children}</button>;
}

function Bloque({ titulo, children, nota }: { titulo: string; children: ReactNode; nota?: string }) {
  return (
    <div className="informe-bloque">
      <h3>{titulo}</h3>
      {children}
      {nota && <p className="nota">{nota}</p>}
    </div>
  );
}

// -------------------------------------------------------------------------------------------- informe
function Contenido({ tipo, periodo, ctx }: { tipo: Tipo; periodo: string; ctx: Contexto }) {
  const rango = useMemo(() => rangoDe(tipo, periodo), [tipo, periodo]);
  const mensual = tipo === 'mes';
  const u = (ruta: string, extra?: Record<string, string>) => conRango(ruta, rango, extra);

  const resumen = useApi<DatosResumen>(u('/api/resumen'));
  const metasR = useApi<DatosMetas>(u('/api/resumen/metas'));
  const sala = useApi<Sala>(u('/api/resumen/sala'));
  const metas = useApi<{ metas: Record<string, Meta> }>('/api/metas');
  const conf = useApi<Confianza>(u('/api/confianza'));
  const camp = useApi<Campanas>(mensual ? u('/api/campanas') : null);
  const embR = useApi<Embudo>(mensual ? u('/api/campanas/embudo', { campana: 'reminder' }) : null);
  const embE = useApi<Embudo>(mensual ? u('/api/campanas/embudo', { campana: 'execute' }) : null);
  const hist = useApi<Historia>(u('/api/chatbot/historia'));
  const ahorro = useApi<Ahorro>(u('/api/chatbot/ahorro'));
  const oport = useApi<{ frases: Frase[] }>(u('/api/chatbot/oportunidades'));
  const cap = useApi<Capacidad>(u('/api/capacidad'));
  const canc = useApi<Cancelaciones>(u('/api/capacidad/cancelaciones'));
  const recup = useApi<Recuperables>('/api/capacidad/recuperables');
  const inas = useApi<Inasistencia>(u('/api/agenda/inasistencia'));
  const cal = useApi<Calidad>(u('/api/campanas/calidad'));
  const fatiga = useApi<Fatiga>(mensual ? u('/api/campanas/fatiga') : null);
  const series = useApi<Series>(mensual ? u('/api/resumen/series') : null);
  const incidentes = useContext(IncidentesCtx);

  const todas = [resumen, metasR, sala, metas, conf, hist, ahorro, oport, cap, canc, recup, inas, cal, ...(mensual ? [camp, embR, embE, fatiga, series] : [])];
  const listas = todas.filter((x) => x.data).length;
  const error = todas.find((x) => x.error)?.error ?? null;

  const optCitas = useCallback(() => {
    const d = series.data!;
    const { periodos, series: s } = pivotar(d.citas, 'grupo', 'n', ['Asistió', 'Cancelada', 'Reprogramada', 'No asistió', 'Programada', 'Sin cierre']);
    return barrasApiladas(periodos, s, d.rango.grano);
  }, [series.data]);

  if (error) return <div className="error">No se pudo preparar el informe: {error}</div>;
  if (listas < todas.length) {
    return (
      <div className="informe-preparando">
        Preparando el informe… {listas} de {todas.length} secciones listas.
        <div className="barra-confianza" style={{ maxWidth: 320, marginTop: 8 }}>
          <span style={{ width: `${Math.round((listas / todas.length) * 100)}%`, background: 'var(--accent)' }} />
        </div>
      </div>
    );
  }

  const a = resumen.data!.actual;
  const p = resumen.data!.anterior ?? undefined;
  const compTxt = resumen.data!.comparacion.tipo === 'interanual' ? 'vs mismo período del año anterior' : mensual ? 'vs mes anterior' : 'vs semana anterior';
  const md = metasR.data!;
  const ocupacion = md.ocupacion.cupos ? md.ocupacion.ocupan / md.ocupacion.cupos : null;
  const dias = Math.round((Date.parse(rango.hasta) - Date.parse(rango.desde)) / 86_400_000) + 1;
  const meta = (k: string): MetaKpi | null => {
    const x = metas.data!.metas[k];
    if (!x || x.valor === null) return null;
    return { valor: x.tipo === 'mensual' ? (x.valor * dias) / 30.4 : x.valor, mejorSiSube: x.mejorSiSube, mensual: x.tipo === 'mensual' };
  };
  const sinMeta = (k: string) => (metas.data!.metas[k]?.valor === null ? 'Sin meta definida' : undefined);
  const tend: Semana[] = sala.data!.tendencia;
  const serie = (k: keyof Semana) => tend.map((x) => x[k] as number | null);

  const recomendaciones = recomendar({
    resumen: resumen.data!,
    metas: metas.data!.metas,
    inas: inas.data!,
    canc: canc.data!,
    cap: cap.data!,
    oport: oport.data!,
    cal: cal.data!,
    fatiga: fatiga.data ?? undefined,
    recup: recup.data!,
  });

  const e = hist.data!.embudo;
  const terminadas = e.completadas + e.derivadas;
  const capT = cap.data!.profesionales.reduce((s, x) => ({ cupos: s.cupos + x.cupos, ocupan: s.ocupan + x.ocupan, libres: s.libres + x.libres }), { cupos: 0, ocupan: 0, libres: 0 });
  const franjas = cap.data!.franjas.filter((c) => c.ofrecidos >= 8 && c.dia <= 6).map((c) => ({ ...c, t: c.libres / c.ofrecidos })).sort((x, y) => y.t - x.t).slice(0, 3);
  const incPeriodo = incidentes.filter((i) => i.desde <= rango.hasta && i.hasta >= rango.desde);
  const k = canc.data!.kpis;

  const etapasDe = (emb: Embudo, conAsistencia: boolean) => {
    const conSeg = !!emb.seguimientoDesde && rango.desde >= emb.seguimientoDesde;
    const nota = emb.seguimientoDesde ? `Dato disponible desde el ${fecha(emb.seguimientoDesde)}` : 'Sin dato';
    return [
      { nombre: 'Mensajes enviados', valor: emb.etapas.aceptados },
      { nombre: 'Entregados', valor: conSeg ? emb.etapas.entregados : null, nota },
      { nombre: 'Respondieron', valor: emb.etapas.respondieron },
      { nombre: 'Confirmaron la cita', valor: emb.etapas.confirmaron },
      ...(conAsistencia ? [{ nombre: 'Confirmaron y asistieron', valor: emb.etapas.confirmaron_y_asistieron, estimada: true }] : []),
    ];
  };

  let pagina = 1;
  return (
    <div className="informe-documento">
      {/* Portada */}
      <section className="informe-hoja informe-portada">
        <img src={logo} alt={ctx.ips} className="informe-logo" />
        <div>
          <div className="informe-tipo">{mensual ? 'Informe mensual de gestión' : 'Resumen semanal de la gerencia'}</div>
          <h1 className="informe-titulo">{tituloPeriodo(tipo, periodo).charAt(0).toUpperCase() + tituloPeriodo(tipo, periodo).slice(1)}</h1>
          <p className="informe-sub">{ctx.ips}</p>
          <nav className="informe-indice" aria-label="Índice del informe">
            <strong>En este informe</strong>
            <IrA id="informe-resumen">Resumen para la gerencia</IrA>
            {mensual && <IrA id="informe-citas">Citas y asistencia</IrA>}
            <IrA id="informe-whatsapp">{mensual ? 'Campañas y asistente de WhatsApp' : 'Lo que hizo el bot'}</IrA>
            <IrA id="informe-alertas">{mensual ? 'Alertas, lista de espera y confianza de los datos' : 'Para esta semana'}</IrA>
          </nav>
        </div>
        <div className="informe-portada-pie">
          <span>Del {fecha(rango.desde)} al {fecha(rango.hasta)}</span>
          <span>Generado el {fecha(ctx.hoy)}{ctx.preparadoPara ? ` · para ${ctx.preparadoPara}` : ''}</span>
          <span>Panel de reportes · datos de la agenda (Globho), del asistente de WhatsApp y de las campañas</span>
        </div>
      </section>

      {/* Página 1: para la gerencia */}
      <Hoja id="informe-resumen" titulo="Resumen para la gerencia" numero={pagina++}>
        <div className="kpis-principales informe-kpis">
          <KpiPrincipal etiqueta="Citas atendidas" valor={a.citas.asistio} anterior={p?.citas.asistio} comparacion={compTxt} meta={meta('atendidas')} sinMeta={sinMeta('atendidas')} serie={serie('atendidas')} definicion={DEF.atendidas} />
          <KpiPrincipal etiqueta="Tasa de asistencia" formato="pct" valor={asistencia(a.citas)} anterior={p ? asistencia(p.citas) : undefined} comparacion={compTxt} meta={meta('asistencia')} serie={serie('asistencia')} definicion={DEF.asistencia} />
          <KpiPrincipal etiqueta="Cancelaciones y reprogramaciones" formato="pct" mejorSiSube={false} valor={noOcurrio(a.citas)} anterior={p ? noOcurrio(p.citas) : undefined} comparacion={compTxt} meta={meta('no_ocurrieron')} serie={serie('no_ocurrieron')} definicion={DEF.noOcurrieron} />
          <KpiPrincipal etiqueta="Pacientes nuevos atendidos" valor={md.nuevos.nuevos} meta={meta('nuevos')} sinMeta={sinMeta('nuevos')} serie={serie('nuevos')} definicion={DEF.nuevos} />
          <KpiPrincipal etiqueta="Ocupación de la agenda" formato="pct" valor={ocupacion} meta={meta('ocupacion')} serie={serie('ocupacion')} definicion={DEF.ocupacion} />
          <KpiPrincipal etiqueta="Trámites resueltos por WhatsApp" valor={tramites(a)} anterior={p ? tramites(p) : undefined} comparacion={compTxt} meta={meta('tramites')} sinMeta={sinMeta('tramites')} serie={serie('tramites')} definicion={DEF.tramites} />
        </div>
        <Bloque titulo="Lo más relevante">
          <ListaFrases frases={sala.data!.relevante} />
        </Bloque>
        <Bloque titulo="Recomendaciones">
          {recomendaciones.length ? (
            <ol className="informe-recomendaciones">
              {recomendaciones.map((r) => <li key={r.clave}>{conNegritas(r.texto)}</li>)}
            </ol>
          ) : (
            <p className="vacio">Sin recomendaciones para este período: los indicadores están dentro de lo esperado.</p>
          )}
        </Bloque>
      </Hoja>

      {/* Detalle: citas */}
      {mensual && (
        <Hoja id="informe-citas" titulo="Citas y asistencia" numero={pagina++}>
          <Bloque titulo="Citas del mes por estado" nota="Por semana, según la fecha de la cita. Sin reuniones internas.">
            <Grafico opcion={optCitas} alto={240} />
          </Bloque>
          <div className="informe-dos">
            <Bloque titulo="Cifras del mes">
              <ul className="lista-simple">
                <li><span>Citas de pacientes</span><span>{num(a.citas.total)}</span></li>
                <li><span>Atendidas</span><span>{num(a.citas.asistio)}</span></li>
                <li><span>No asistieron</span><span>{num(a.citas.no_asistio)}</span></li>
                <li><span>Canceladas</span><span>{num(a.citas.canceladas)}</span></li>
                <li><span>Reprogramadas</span><span>{num(a.citas.reprogramadas)}</span></li>
                <li><span>Horas de consulta liberadas</span><span>{num(Math.round(k.horas))}</span></li>
                {a.citas.sin_cierre > 0 && <li><span>Sin cierre en Globho</span><span>{num(a.citas.sin_cierre)}</span></li>}
              </ul>
            </Bloque>
            <Bloque titulo="Capacidad de la agenda" nota="Solo profesionales con horario registrado en el sistema.">
              {cap.data!.medible && capT.cupos ? (
                <ul className="lista-simple">
                  <li><span>Ocupación</span><span>{pct(capT.ocupan, capT.cupos, 0)}</span></li>
                  <li><span>Cupos sin usar</span><span>{num(capT.libres)}</span></li>
                  {franjas.map((f) => (
                    <li key={`${f.dia}-${f.hora}`}><span>Sin usar: {DIAS[f.dia].toLowerCase()} {f.hora}:00</span><span>{tasaTxt(f.t, 0)}</span></li>
                  ))}
                </ul>
              ) : (
                <p className="vacio">Sin capacidad medible para el período.</p>
              )}
            </Bloque>
          </div>
        </Hoja>
      )}

      {/* Detalle: WhatsApp */}
      <Hoja id="informe-whatsapp" titulo={mensual ? 'Campañas y asistente de WhatsApp' : 'Lo que hizo el bot'} numero={pagina++}>
        {mensual && embR.data && embE.data && (
          <>
            <Bloque titulo="Recordatorio de 48 horas: del mensaje a la cita">
              <EmbudoEtapas etapas={etapasDe(embR.data, true)} />
            </Bloque>
            <Bloque titulo="Confirmación de 24 horas: del mensaje a la cita">
              <EmbudoEtapas etapas={etapasDe(embE.data, true)} />
            </Bloque>
          </>
        )}
        <div className="informe-dos">
          <Bloque titulo="Asistente de WhatsApp">
            <ul className="lista-simple">
              <li><span>Conversaciones</span><span>{num(e.conversaciones)}</span></li>
              <li><span>Resueltas por el bot</span><span>{num(e.completadas)}</span></li>
              <li><span>Sin intervención humana</span><span>{pct(e.completadas, terminadas, 0)}</span></li>
              <li><span>Trámites con recepción cerrada</span><span>{num(e.completadas_fuera_horario)}</span></li>
            </ul>
          </Bloque>
          <Bloque titulo="Trabajo ahorrado a recepción" nota="Estimado: trámites por WhatsApp × minutos que tomaría cada uno por teléfono.">
            <div className="ahorro-horas">
              {num(Math.round(ahorro.data!.horas))}
              <small>horas</small>
            </div>
            <p className="nota">Equivalen a {String(Math.round((ahorro.data!.horas / 8) * 10) / 10).replace('.', ',')} jornadas de 8 horas.</p>
          </Bloque>
        </div>
        {mensual && camp.data && (
          <Bloque titulo="Resultados por campaña">
            <table className="informe-tabla">
              <thead>
                <tr><th>Campaña</th><th className="num">Enviados</th><th className="num">Respondieron</th><th className="num">Confirmaron</th><th className="num">Fallidos</th></tr>
              </thead>
              <tbody>
                {camp.data.porCampana.filter((c) => c.enviados >= 10).map((c) => (
                  <tr key={c.campana}>
                    <td>{etiqueta(c.campana)}</td>
                    <td className="num">{num(c.enviados)}</td>
                    <td className="num">{pct(c.respondieron + c.respondieron_tarde, c.enviados, 0)}</td>
                    <td className="num">{c.citas_confirmadas ? pct(c.citas_confirmadas, c.enviados, 0) : '—'}</td>
                    <td className="num">{num(c.fallidos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Bloque>
        )}
        <Bloque titulo="Oportunidades de mejora del bot">
          <ListaFrases frases={oport.data!.frases} />
        </Bloque>
      </Hoja>

      {/* Alertas y confianza */}
      <Hoja id="informe-alertas" titulo={mensual ? 'Alertas, lista de espera y confianza de los datos' : 'Para esta semana'} numero={pagina++}>
        <div className="informe-dos">
          <Bloque titulo="Primera cita disponible" nota={`A la fecha de generación (${fecha(ctx.hoy)}), según el horario registrado.`}>
            {cap.data!.espera.length ? (
              <ul className="lista-simple">
                {cap.data!.espera.map((x) => (
                  <li key={x.especialidad}><span>{x.especialidad}</span><span>{x.dias === null ? 'Sin cupos en 30 días' : x.dias === 0 ? 'Hoy' : `En ${x.dias} días`} · {num(x.libres_7d)} cupos libres en 7 días</span></li>
                ))}
              </ul>
            ) : (
              <p className="vacio">Sin especialidades con horario medible.</p>
            )}
          </Bloque>
          <Bloque titulo="Lista de espera">
            <ul className="lista-simple">
              <li><span>Pacientes inscritos esperando cupo</span><span>{num((recup.data!.filas ?? []).reduce((s, f) => s + f.inscritos, 0))}</span></li>
              <li><span>Cupos recolocados en el período</span><span>{num(canc.data!.recolocados)}</span></li>
            </ul>
          </Bloque>
        </div>
        <Bloque titulo="Alertas y pendientes al generar el informe">
          <ListaAtencion items={sala.data!.atencion} />
          {incPeriodo.length > 0 && (
            <p className="nota">
              Incidentes de datos que tocan el período: {incPeriodo.map((i) => `${i.titulo} (${fecha(i.desde)} a ${fecha(i.hasta)})`).join('; ')}. Las cifras afectadas pueden quedar por debajo de la real.
            </p>
          )}
        </Bloque>
        <Bloque titulo="Confianza de los datos">
          <MedidorConfianza c={conf.data!} detalle />
        </Bloque>
      </Hoja>
    </div>
  );
}

function Informe({ tipo }: { tipo: Tipo }) {
  const ctx = useApi<Contexto>(tipo === 'mes' ? '/api/informe' : '/api/informe/semanal');
  const opciones = (tipo === 'mes' ? ctx.data?.meses : ctx.data?.semanas) ?? [];
  const [elegido, setElegido] = useState('');
  const periodo = elegido && opciones.includes(elegido) ? elegido : opciones[0];

  const imprimir = () => {
    registrar('exportacion', tipo === 'mes' ? 'informe-mensual' : 'resumen-semanal', periodo);
    // Los gráficos se pintan en claro antes de abrir el diálogo; el panel restaura el tema al terminar.
    document.documentElement.dataset.theme = 'light';
    setTimeout(() => window.print(), 500);
  };

  return (
    <div className="informe">
      <div className="informe-barra">
        <label>
          {tipo === 'mes' ? 'Mes' : 'Semana'}{' '}
          <select className="boton" value={periodo ?? ''} onChange={(e) => setElegido(e.target.value)}>
            {opciones.map((o) => (
              <option key={o} value={o}>{tipo === 'mes' ? nombreMes(o) : `${fecha(o)} al ${fecha(sumar(o, 6))}`}</option>
            ))}
          </select>
        </label>
        <button className="boton boton-primario" disabled={!periodo} onClick={imprimir}>
          Imprimir o guardar en PDF
        </button>
        <span className="nota" style={{ margin: 0 }}>
          {tipo === 'mes'
            ? 'En el diálogo de impresión elija "Guardar como PDF" para enviarlo o llevarlo a la junta.'
            : 'Cada lunes queda listo el resumen de la semana anterior.'}
        </span>
      </div>
      <Estado cargando={ctx.cargando} error={ctx.error} hayDatos={!!ctx.data} forma="bloque" />
      {ctx.data && periodo && <Contenido key={periodo} tipo={tipo} periodo={periodo} ctx={ctx.data} />}
      {ctx.data && !periodo && <p className="vacio">No hay períodos completos disponibles en su plan.</p>}
    </div>
  );
}

export function InformeMensual(_: { rango: Rango }) {
  return <Informe tipo="mes" />;
}

export function ResumenSemanal(_: { rango: Rango }) {
  return <Informe tipo="semana" />;
}
