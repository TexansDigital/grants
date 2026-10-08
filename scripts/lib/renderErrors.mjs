/**
 * Turn a render error into a named failure instead of a timeout.
 *
 * WHY THIS IS SHARED. A component that throws does not fail a browser harness
 * in any readable way. `web/src/ErrorBoundary.tsx` catches the error, so
 * Playwright's `pageerror` never fires; the panel is quietly replaced by the
 * boundary's fallback, the next locator waits ten seconds, and the harness
 * dies on a stack trace about the locator. The actual cause -- a TypeError in
 * the component -- appears nowhere in the output.
 *
 * A sweep on 2026-10-08 found this in 24 of the 25 harnesses: eleven listened
 * for `pageerror`, which does not see a caught render error, and thirteen
 * listened for nothing. The commonest cause is a hand-written stub drifting
 * from the server's payload, which has cost this project seven debugging
 * sessions. The mistake will keep being made; this makes it legible the first
 * time it is seen.
 *
 * TWO LISTENERS, because they catch different things:
 *
 *   - the console line the error boundary logs, which carries the real message
 *     for anything thrown during render;
 *   - `pageerror`, for everything outside render -- an event handler, a
 *     promise, a listener -- where nothing catches it and no boundary runs.
 *
 * It patches `newPage` on the browser and on any context, so a harness gets
 * this for every page it opens without changing how it opens them.
 */
export function watchRenderErrors(browser, fail) {
  const wire = (page) => {
    page.on('pageerror', (e) => {
      fail(`nothing thrown on the page — got: ${String(e).split('\n')[0].slice(0, 160)}`);
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      // The marker the error boundary logs. Matching the marker rather than
      // every console error, because a harness may legitimately provoke one.
      if (!text.includes('Steward render error')) return;
      fail(`nothing threw during render — got: ${text.split('\n')[0].slice(0, 160)}`);
    });
    return page;
  };

  const browserNewPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => wire(await browserNewPage(...args));

  const browserNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await browserNewContext(...args);
    const contextNewPage = context.newPage.bind(context);
    context.newPage = async (...inner) => wire(await contextNewPage(...inner));
    return context;
  };

  return browser;
}
