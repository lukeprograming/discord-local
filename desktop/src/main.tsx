import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import { app } from './app.ts';
import './styles.css';

app.boot();
// Acesso pelo DevTools (testes automatizados e depuração).
(window as unknown as { __app: typeof app }).__app = app;
createRoot(document.getElementById('root')!).render(<App />);
