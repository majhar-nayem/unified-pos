import { useEffect, useState, useSyncExternalStore } from 'react';

import { ServicesProvider, type Services } from './app/services.js';
import { CfdView } from './screens/CfdView.js';
import { DiagnosticsScreen } from './screens/DiagnosticsScreen.js';
import { EnrollmentScreen } from './screens/EnrollmentScreen.js';
import { PinScreen } from './screens/PinScreen.js';
import { Shell } from './screens/Shell.js';

type Route = 'shell' | 'diagnostics';

function Router({ services }: { services: Services }) {
  const { session } = services;
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const [route, setRoute] = useState<Route>('shell');

  // Signing out always lands back on the register route for the next person.
  useEffect(() => {
    if (state.phase !== 'signed_in') setRoute('shell');
  }, [state.phase]);

  switch (state.phase) {
    case 'loading':
      return (
        <main className="center-screen" aria-busy="true">
          <p>Starting…</p>
        </main>
      );
    case 'unenrolled':
      return <EnrollmentScreen notice={state.notice} />;
    case 'signed_out':
      return <PinScreen state={state} />;
    case 'signed_in':
      return route === 'diagnostics' ? (
        <DiagnosticsScreen onBack={() => setRoute('shell')} />
      ) : (
        <Shell state={state} onNavigate={setRoute} />
      );
  }
}

export function App({
  services,
  mode = 'register',
}: {
  services: Services;
  mode?: 'register' | 'cfd';
}) {
  if (mode === 'cfd') return <CfdView transport={services.cfd} />;
  return (
    <ServicesProvider services={services}>
      <Router services={services} />
    </ServicesProvider>
  );
}
