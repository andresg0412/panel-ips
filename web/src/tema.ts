// Tema claro/oscuro del panel. Vive aparte para que lo apliquen tanto el panel como la pantalla de acceso (H15):
// quien aún no inició sesión también merece ver su tema guardado, sin destello.
export type Tema = 'auto' | 'light' | 'dark';

export function leerTema(): Tema {
  try {
    const v = localStorage.getItem('panel.tema');
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function aplicarTema(t: Tema) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
