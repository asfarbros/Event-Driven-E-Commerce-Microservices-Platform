import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';

const root = createRoot(document.getElementById('root')!);

/**
 * Configuration is validated before anything renders: a missing VITE_* value
 * shows a readable page instead of a broken store. The app module is loaded
 * only after that check so its top-level `config` import cannot throw unseen.
 */
async function boot() {
  try {
    const { config } = await import('./config/env');
    const { App } = await import('./App');
    root.render(<StrictMode><App config={config} /></StrictMode>);
  } catch (err) {
    const problems = (err as { problems?: string[] }).problems ?? [String(err)];
    root.render(
      <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '4rem auto', padding: '0 1rem', color: '#18181b' }}>
        <h1 style={{ fontSize: '1.5rem' }}>OrderFlow can’t start</h1>
        <p>The storefront is missing configuration. Set these in the root <code>.env</code> (see <code>.env.example</code>) and restart:</p>
        <ul>{problems.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
      </main>,
    );
  }
}
boot();
