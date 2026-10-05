import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [];
const check = (label, condition) => {
  assert.ok(condition, label);
  checks.push(label);
};

const app = read('web/src/App.tsx');
const ui = read('web/src/components/ui.tsx');
const tabs = read('web/src/incidentes.tsx');
const resumen = read('web/src/pages/Resumen.tsx');
const alertas = read('web/src/pages/Alertas.tsx');
const informe = read('web/src/pages/Informe.tsx');
const css = read('web/src/styles.css');

check('El menú usa lenguaje orientado a tareas', app.includes('Ver el estado de la IPS') && app.includes('Gestionar la operación') && app.includes('Pacientes y comunicación') && app.includes('Cuenta y sistema'));
check('Alertas está junto a Resumen', /paginas: \['resumen', 'alertas'/.test(app));
check('La vista por rol tiene orden personalizado', app.includes('const ORDEN_ROL') && app.includes('ordenRol.indexOf'));
check('Se guardan vistas recientes', app.includes("panel.recientes") && app.includes('Vistos recientemente'));
check('El período seleccionado es visible', app.includes('periodo-seleccionado'));
check('La navegación contextual existe', app.includes('Navegación contextual') && app.includes("['resumen', 'alertas'].filter((r) => r !== ruta && estadoPagina(r) === 'ok')"));
check('Las pestañas admiten explicación contextual', tabs.includes('descripciones?: Partial<Record<T, string>>') && tabs.includes('pestana-ayuda'));
check('Las pestañas usan preguntas en Inteligencia y Pacientes', read('web/src/pages/Inteligencia.tsx').includes('¿Quién podría faltar?') && read('web/src/pages/Pacientes.tsx').includes('¿Cómo es nuestra población?'));
check('Las tablas limitan la vista inicial a 10 filas', ui.includes('const FILAS_INICIALES = 10') && ui.includes("i >= FILAS_INICIALES ? 'fila-extra'"));
check('Las tablas imprimen todas sus filas', !ui.includes('ordenadas.slice(') && /@media print \{[^@]*\.fila-extra \{ display: table-row; \}/.test(css));
check('Las tablas permiten ver todas las filas', ui.includes("'Ver todas'") && ui.includes("'Mostrar menos'"));
check('Las tablas permiten elegir columnas', ui.includes('columnasVisibles') && ui.includes('Elegir columnas'));
check('La exportación conserva todas las filas y columnas', ui.includes('descargarCsv(nombreCsv, ordenadas, columnas)'));
check('El resumen tiene tres KPIs principales', resumen.includes('Ocupación de la agenda') && resumen.includes('Ver más indicadores'));
check('La portada tiene acciones recomendadas', resumen.includes('Qué hacer ahora') && resumen.includes('acciones-recomendadas'));
check('El detalle del resumen es expandible', resumen.includes('Explorar el detalle del período'));
check('Las alertas tienen filtros por prioridad', alertas.includes("'criticas' | 'importantes'") && alertas.includes('alertas-filtros'));
check('Las alertas separan qué pasó del detalle', alertas.includes('Qué pasó:') && alertas.includes('Detalle:'));
check('El informe tiene índice navegable', informe.includes('informe-indice') && informe.includes('informe-resumen') && informe.includes('informe-alertas'));
check('El índice del informe no usa anclas #seccion (el hash es la ruta del panel)', !/href="#informe-/.test(informe) && informe.includes('scrollIntoView'));
check('Los bloques plegados se imprimen abiertos', css.includes('.bloque-detalle::details-content { content-visibility: visible') && app.includes("details.bloque-detalle:not([open])"));
check('En móvil la barra superior queda por encima de la barra de herramientas', Number(css.match(/\.barra-movil \{[^}]*z-index: (\d+)/)[1]) > Number(css.match(/\.herramientas \{ position: sticky[^}]*z-index: (\d+)/)[1]));
check('La barra de acciones es persistente al desplazarse', css.includes('.herramientas { position: sticky'));
check('La primera columna de las tablas queda fija', css.includes('.tabla-wrap th:first-child, .tabla-wrap td:first-child'));
check('Las pestañas son utilizables en pantallas estrechas', css.includes('.pestanas { display: flex; flex-wrap: nowrap') && css.includes('overflow-x: auto'));

console.log(`UX smoke test: ${checks.length} comprobaciones OK`);
