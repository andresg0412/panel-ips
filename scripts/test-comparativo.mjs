// Prueba de la resolución de periodos del comparativo (server/comparativo.ts). No necesita base de datos: la función
// es pura y recibe "hoy". Casos: proyecto-ips/docs/features/2026-11-09-comparativo-periodos-panel.md, sección 8 y 9.1.
//   npm run test:comparativo
import assert from 'node:assert/strict';
import { avisosSinCierre, mesMas, resolverComparativo, ttlComparativo, ultimoDiaMes } from '../server/comparativo.ts';
import { ErrorHistorialPlan, ErrorParametro } from '../server/params.ts';

let comprobaciones = 0;
const check = (etiqueta, condicion) => {
  assert.ok(condicion, etiqueta);
  comprobaciones++;
};

const FULL = { nivel: 'full', historialDesde: null };
const HOY = '2026-11-09';
const resolver = (q, ctx = FULL, hoy = HOY) => resolverComparativo(q, ctx, hoy);
const codigos = (c) => c.avisos.map((a) => a.codigo);

/** La llamada debe lanzar `Clase` con exactamente ese mensaje. */
function rechaza(etiqueta, q, mensaje, { ctx = FULL, hoy = HOY, clase = ErrorParametro } = {}) {
  try {
    resolver(q, ctx, hoy);
  } catch (e) {
    check(`${etiqueta}: es ${clase.name}`, e instanceof clase);
    check(`${etiqueta}: mensaje`, e.message === mensaje);
    return e;
  }
  assert.fail(`${etiqueta}: debía rechazarse`);
}

// ---------------------------------------------------------------------------------------- calendario
check('mesMas retrocede un mes', mesMas('2026-11', -1) === '2026-10');
check('mesMas cruza el año hacia atrás', mesMas('2027-01', -1) === '2026-12');
check('mesMas cruza el año hacia adelante', mesMas('2026-12', 1) === '2027-01');
check('mesMas resta un año', mesMas('2026-10', -12) === '2025-10');
check('Febrero normal tiene 28 días', ultimoDiaMes('2027-02') === 28);
check('Febrero bisiesto tiene 29 días', ultimoDiaMes('2028-02') === 29);
check('Diciembre tiene 31 días', ultimoDiaMes('2026-12') === 31);

// ------------------------------------------------------------------------------- modos y valores por defecto
{
  const c = resolver({});
  check('Sin parámetros: A es el mes en curso, B el anterior, "mes anterior" y corte al mismo día', c.modo === 'mes_anterior' && c.a.mes === '2026-11' && c.b.mes === '2026-10' && c.corte === 'mismo_dia');
  check('Mes en curso: se corta en ayer (día 8) en los dos meses', c.diaCorte === 8 && c.a.hasta === '2026-11-08' && c.b.hasta === '2026-10-08' && c.a.dias === 8 && c.b.dias === 8);
  check('Marca el mes en curso y solo ese', c.a.enCurso && !c.b.enCurso);
  check('Los periodos empiezan el día 1', c.a.desde === '2026-11-01' && c.b.desde === '2026-10-01');
  check('La etiqueta va en español', c.a.etiqueta === 'noviembre 2026' && c.b.etiqueta === 'octubre 2026');
  check('ttl corto con el mes en curso', ttlComparativo(c) === 120_000);
}
{
  const c = resolver({ mesA: '2026-10' });
  check('Mes cerrado: el corte por defecto es el mes completo', c.corte === 'completo' && c.diaCorte === null);
  check('Mes completo: hasta el último día de cada mes', c.a.hasta === '2026-10-31' && c.b.hasta === '2026-09-30' && c.a.dias === 31 && c.b.dias === 30);
  check('Con meses de distinta duración avisa (informativo)', codigos(c).includes('dias_distintos'));
  check('ttl largo con ambos meses cerrados', ttlComparativo(c) === 600_000);
}
{
  const c = resolver({ mesA: '2026-10', modo: 'interanual' });
  check('Interanual: B es el mismo mes del año anterior', c.modo === 'interanual' && c.b.mes === '2025-10');
}
{
  const c = resolver({ mesA: '2026-10', modo: 'interanual', mesB: '2026-01' });
  check('Interanual ignora mesB', c.b.mes === '2025-10');
  const m = resolver({ mesA: '2026-10', modo: 'mes_anterior', mesB: '2026-01' });
  check('Mes anterior ignora mesB', m.b.mes === '2026-09');
}
{
  const c = resolver({ modo: 'libre', mesA: '2026-03', mesB: '2026-08' });
  check('Modo libre (caso 7): A anterior a B se respeta, sin reordenar', c.a.mes === '2026-03' && c.b.mes === '2026-08');
}

// ------------------------------------------------------------------------------------------- corte
{
  const c = resolver({ mesA: '2026-10', corte: 'mismo_dia' });
  check('Mes cerrado con corte al mismo día: usa el día de hoy (9)', c.diaCorte === 9 && c.a.hasta === '2026-10-09' && c.b.hasta === '2026-09-09');
}
{
  const c = resolver({ mesA: '2026-11', corte: 'completo' });
  check('Mes en curso, completo (caso 2): funciona y avisa que los totales están incompletos', c.a.hasta === '2026-11-30' && codigos(c).includes('mes_en_curso_completo'));
  check('El aviso del mes en curso empieza con mayúscula', c.avisos.find((a) => a.codigo === 'mes_en_curso_completo').texto.startsWith('Noviembre 2026 todavía no termina'));
}
{
  // Caso 3: corte 31 contra un mes de 30 días y contra febrero.
  const c = resolver({ mesA: '2026-10', corte: 'mismo_dia' }, FULL, '2026-10-31');
  check('Corte 31 contra un mes de 30 días (caso 3): hasta el día 30', c.diaCorte === 30 && c.b.hasta === '2026-09-30' && c.a.hasta === '2026-10-30');
  const f = resolver({ mesA: '2027-03', corte: 'mismo_dia' }, FULL, '2027-03-31');
  check('Corte 30 contra febrero de 28 días: hasta el 28', f.diaCorte === 30 && f.b.hasta === '2027-02-28');
  const g = resolver({ mesA: '2028-03', corte: 'mismo_dia' }, FULL, '2028-03-31');
  check('Febrero bisiesto (2028): hasta el 29', g.b.hasta === '2028-02-29');
  const h = resolver({ mesA: '2028-02', corte: 'completo' }, FULL, '2028-03-15');
  check('Mes completo en bisiesto: febrero 2028 tiene 29 días', h.a.hasta === '2028-02-29' && h.a.dias === 29);
}
rechaza('Día 1 con el mes en curso elegido al mismo día (caso 1)', { mesA: '2026-11' }, "El mes en curso todavía no tiene días cerrados. Elija el mes anterior o use 'mes completo'.", { hoy: '2026-11-01' });
{
  const c = resolver({}, FULL, '2026-11-01');
  check('Día 1 sin parámetros: abre el mes anterior completo, sin error', c.a.mes === '2026-10' && c.b.mes === '2026-09' && c.corte === 'completo' && c.a.hasta === '2026-10-31');
}
{
  const c = resolver({ modo: 'libre', mesA: '2026-10', mesB: '2026-11' });
  check('Libre con B en curso: corte por defecto al mismo día', c.corte === 'mismo_dia');
  check('Libre con B en curso: los dos se cortan en ayer (día 8), sin las citas de hoy', c.diaCorte === 8 && c.a.hasta === '2026-10-08' && c.b.hasta === '2026-11-08');
  rechaza('Libre con B en curso el día 1', { modo: 'libre', mesA: '2026-10', mesB: '2026-11' }, "El mes en curso todavía no tiene días cerrados. Elija el mes anterior o use 'mes completo'.", { hoy: '2026-11-01' });
}
{
  const c = resolver({ mesA: '2026-11', corte: 'completo' }, FULL, '2026-11-01');
  check('Día 1 con mes completo sí funciona', c.a.hasta === '2026-11-30');
  const d = resolver({ mesA: '2026-10' }, FULL, '2026-11-01');
  check('Día 1 con un mes cerrado sí funciona', d.a.hasta === '2026-10-31');
}

// ------------------------------------------------------------------------------------- cambio de año
{
  const c = resolver({ mesA: '2027-01', corte: 'completo' }, FULL, '2027-02-10');
  check('Cambio de año: enero 2027 contra diciembre 2026', c.b.mes === '2026-12' && c.b.hasta === '2026-12-31');
}

// ------------------------------------------------------------------------------------------- carga inicial
{
  const c = resolver({ mesA: '2025-09', corte: 'completo' });
  check('A = 2025-09 contra agosto (caso 4): funciona con aviso de carga inicial', c.b.mes === '2025-08' && c.b.cargaInicial && !c.a.cargaInicial && codigos(c).includes('carga_inicial'));
}
rechaza('A = 2025-08 contra el mes anterior (caso 5)', { mesA: '2025-08' }, 'Los datos empiezan en agosto de 2025');
rechaza('Interanual con A anterior a 2026-08 (caso 6)', { mesA: '2026-07', modo: 'interanual' }, 'Los datos empiezan en agosto de 2025');
{
  const c = resolver({ mesA: '2026-08', modo: 'interanual', corte: 'completo' });
  check('Interanual desde 2026-08 llega justo a la carga inicial', c.b.mes === '2025-08' && c.b.cargaInicial);
}

// ------------------------------------------------------------------------------------------- incidentes
{
  // Incidente general del 2026-04-01 al 2026-08-05 (INCIDENTES_BASE).
  const c = resolver({ mesA: '2026-05', modo: 'libre', mesB: '2026-10' });
  check('Mes casi entero en un incidente: aviso "incidente" y fracción alta', c.a.fraccionIncidente === 1 && codigos(c).includes('incidente'));
  check('El mes sin incidentes no avisa', c.b.fraccionIncidente === 0);
  const p = resolver({ mesA: '2026-08', modo: 'libre', mesB: '2026-10', corte: 'completo' });
  check('Mes con solo 5 de 31 días en incidente: aviso parcial', codigos(p).includes('incidente_parcial') && !codigos(p).includes('incidente'));
}

// ------------------------------------------------------------------------------------- validaciones
rechaza('Mes con formato inválido', { mesA: 'abc' }, 'Mes inválido: use el formato AAAA-MM');
rechaza('Mes 13 (caso 15)', { mesA: '2026-13' }, 'Mes inválido: use el formato AAAA-MM');
rechaza('Mes 00', { mesA: '2026-00' }, 'Mes inválido: use el formato AAAA-MM');
rechaza('Texto de inyección en mesA (caso 15)', { mesA: "2026-10'; DROP TABLE agenda;--" }, 'Mes inválido: use el formato AAAA-MM');
rechaza('Mes repetido en la URL (llega como lista)', { mesA: ['2026-10', '2026-09'] }, 'Mes inválido: use el formato AAAA-MM');
rechaza('mesB inválido en modo libre', { modo: 'libre', mesA: '2026-10', mesB: '2026-1' }, 'Mes inválido: use el formato AAAA-MM');
rechaza('Modo desconocido', { modo: 'semanal' }, 'Modo de comparación inválido');
rechaza('Corte desconocido', { corte: 'quincena' }, 'Modo de comparación inválido');
rechaza('Modo libre sin mesB', { modo: 'libre', mesA: '2026-10' }, 'Elija el mes con el que quiere comparar');
rechaza('Dos meses iguales', { modo: 'libre', mesA: '2026-10', mesB: '2026-10' }, 'Elija dos meses distintos');
rechaza('A en el futuro', { mesA: '2026-12' }, 'No se puede comparar un mes que todavía no empieza');
rechaza('B en el futuro', { modo: 'libre', mesA: '2026-10', mesB: '2027-01' }, 'No se puede comparar un mes que todavía no empieza');
rechaza('B anterior a los datos', { modo: 'libre', mesA: '2026-10', mesB: '2025-07' }, 'Los datos empiezan en agosto de 2025');

// ------------------------------------------------------------------------------------------- historial del plan
{
  const intermedio = { nivel: 'intermedio', historialDesde: '2025-11-10' };
  const e = rechaza(
    'Un mes fuera del historial del plan (caso 13)',
    { mesA: '2026-10', modo: 'interanual', corte: 'completo' },
    'Disponible en el plan Full: su plan incluye los últimos 365 días',
    { ctx: intermedio, clase: ErrorHistorialPlan },
  );
  check('El error pide el plan Full', e.nivel === 'full');
  rechaza('Un mes que empieza antes del primer día del historial', { mesA: '2025-11', corte: 'completo' }, 'Disponible en el plan Full: su plan incluye los últimos 365 días', {
    ctx: intermedio,
    clase: ErrorHistorialPlan,
  });
  const dentro = resolver({ mesA: '2026-10' }, intermedio);
  check('Dos meses dentro del historial se resuelven normalmente', dentro.a.mes === '2026-10' && dentro.b.mes === '2026-09');
  const sinLimite = resolver({ mesA: '2026-10', modo: 'interanual' }, { nivel: 'full', historialDesde: null });
  check('Sin límite de historial (Full) no se valida', sinLimite.b.mes === '2025-10');
}

// ---------------------------------------------------------------------------------------- aviso sin cierre
{
  const c = resolver({ mesA: '2026-10', corte: 'completo' });
  const avisos = avisosSinCierre([
    { periodo: c.a, sinCierre: 6, total: 100 },
    { periodo: c.b, sinCierre: 5, total: 100 },
  ]);
  check('Sin cierre por encima del 5 %: avisa solo de ese periodo', avisos.length === 1 && avisos[0].codigo === 'sin_cierre' && avisos[0].texto === '6 citas de octubre 2026 siguen sin cierre: no se sabe si ocurrieron.');
  check('Un periodo sin citas no avisa', avisosSinCierre([{ periodo: c.a, sinCierre: 0, total: 0 }]).length === 0);
}

console.log(`Comparativo: ${comprobaciones} comprobaciones OK`);
