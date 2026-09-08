import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The applicant form and the internal shell are one React app, built to
 * ../public and served by the Worker itself via wrangler's [assets].
 *
 * Same origin as the API, so: no CORS, one deploy, one hostname for Access to
 * sit in front of. A separate Pages project would have meant three of those
 * problems for no benefit at this size.
 *
 * No inline script or style: the Worker sets a Content-Security-Policy of
 * `script-src 'self'` and the build has to fit the policy, not the other way
 * round.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
    // Source maps for a form that nonprofits fill in over an hour: when
    // something breaks for one applicant, the stack trace has to be readable.
    sourcemap: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787',
    },
  },
});
