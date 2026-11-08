// Instala o window.native do Android antes de a interface do desktop subir.
import './polyfills.ts';
import './native.ts';
import '../../desktop/src/main.tsx';

// Subiu sem erro de sintaxe: o aviso de WebView velho (index.html) não precisa aparecer.
(window as unknown as { __dlBooted: boolean }).__dlBooted = true;
