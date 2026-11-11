import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import '../styles/app.css';

export function mount(component: ReactNode) {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing extension root');
  createRoot(root).render(<StrictMode>{component}</StrictMode>);
}
