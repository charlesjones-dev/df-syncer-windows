import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './api'; // Side-effect: extends `Window` with the typed `df` bridge.
import { api } from './api';
import { WizardShell } from './components/wizard/WizardShell';
import { Dashboard } from './components/main/Dashboard';
import './styles/wizard.css';
import './styles/dashboard.css';

/**
 * Renderer entry. On boot we ask the main process whether this is a
 * first-run state; if so we mount the setup wizard, otherwise the
 * post-wizard dashboard.
 */

type BootState =
  | { status: 'loading' }
  | { status: 'wizard' }
  | { status: 'dashboard' }
  | { status: 'error'; message: string };

function App(): JSX.Element {
  const [boot, setBoot] = useState<BootState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const firstRun = await api.config.isFirstRun();
        if (cancelled) return;
        setBoot({ status: firstRun ? 'wizard' : 'dashboard' });
      } catch (err) {
        if (cancelled) return;
        setBoot({
          status: 'error',
          message: err instanceof Error ? err.message : String(err)
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (boot.status === 'loading') {
    return (
      <main className="scaffold">
        <p className="scaffold__text">Loading...</p>
      </main>
    );
  }

  if (boot.status === 'error') {
    return (
      <main className="scaffold">
        <p className="scaffold__text">Failed to load: {boot.message}</p>
      </main>
    );
  }

  if (boot.status === 'wizard') {
    return <WizardShell onExit={() => setBoot({ status: 'dashboard' })} />;
  }

  return <Dashboard />;
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
