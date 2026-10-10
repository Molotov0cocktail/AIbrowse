import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import type { RuntimeUiBridge } from '../../../tools/data-qualification/runtime/ui-protocol';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (__E2_RUNTIME_QUALIFICATION__) {
  const bridge = (window as unknown as { e2RuntimeQualification: RuntimeUiBridge })
    .e2RuntimeQualification;
  let sequence = 0;
  let pending = false;
  const timer = window.setInterval(() => {
    if (pending || sequence >= 1802) return;
    pending = true;
    const current = ++sequence;
    const started = performance.now();
    void bridge
      .ping(current)
      .then(async (reply) => {
        if (reply !== current || !(await bridge.sample(current, performance.now() - started)))
          throw new Error('资格 UI 往返失败');
      })
      .catch(() => window.clearInterval(timer))
      .finally(() => {
        pending = false;
      });
  }, 50);
}
