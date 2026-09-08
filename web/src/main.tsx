/**
 * Entry point.
 *
 * StrictMode is on: it double-invokes effects in development, which is how the
 * autosave effect's cleanup and the abort handling in App were shaken out.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import './form.css';
import './internal.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
