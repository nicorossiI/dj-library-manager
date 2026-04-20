/**
 * src/main/handlers/rekordbox.js
 *
 * Handler: rekordbox:preview, rekordbox:generate-xml, library:exportRekordbox (legacy).
 */

'use strict';

const rekordboxExportService = require('../../services/rekordboxExportService');

function register(ctx) {
  const { ipcMain, appState, send, emitLog, ok, fail } = ctx;

  ipcMain.handle('rekordbox:preview', async () => {
    try {
      const tracks = appState.organizedTracks.length ? appState.organizedTracks : appState.loadedTracks;
      if (appState.organizePreview?.tree) {
        return ok({
          tree: appState.organizePreview.tree,
          stats: appState.organizePreview.stats,
          fromOrganized: appState.organizedTracks.length > 0,
        });
      }
      const groups = rekordboxExportService.groupTracksByPlaylist(tracks);
      const tree = {};
      for (const [name, val] of groups.entries()) {
        if (val.direct) tree[name] = val.direct;
        else tree[name] = { ...val };
      }
      return ok({ tree, stats: null, fromOrganized: appState.organizedTracks.length > 0 });
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('rekordbox:generate-xml', async () => {
    try {
      const useOrganized = appState.organizedTracks.length > 0;
      const tracks = useOrganized ? appState.organizedTracks : appState.loadedTracks;
      if (!appState.outputRoot) throw new Error('outputRoot mancante (esegui organize:execute prima)');
      if (!useOrganized) {
        emitLog('warn', '⚠️', 'rekordbox.xml generato da loadedTracks (path non organizzati). Esegui prima organize:execute.');
      }
      const xmlPath = await rekordboxExportService.generateRekordboxXml(
        tracks, appState.outputRoot,
        (done, total, phase) => {
          send('rekordbox:progress', { done, total, phase });
          send('library:progress', {
            done, total, phase: 'rekordbox',
            label: phase === 'collection' ? `Generazione XML ${done}/${total}`
                 : phase === 'playlists'  ? 'Costruzione playlist...'
                 : phase === 'validating' ? 'Validazione XML...'
                 : phase === 'writing'    ? 'Salvataggio file...'
                 : '',
          });
        },
      );
      appState.rekordboxXmlPath = xmlPath;
      const payload = { xmlPath, stats: { entries: tracks.length } };
      send('rekordbox:xml-complete', payload);
      emitLog('success', '✅', `rekordbox.xml: ${xmlPath}`);
      return ok(payload);
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('library:exportRekordbox', async (_e, { tracks, outputRoot } = {}) => {
    try {
      const t = (tracks && tracks.length) ? tracks
        : (appState.organizedTracks.length ? appState.organizedTracks : appState.loadedTracks);
      const root = outputRoot || appState.outputRoot;
      if (!root) throw new Error('outputRoot mancante');
      const xmlPath = await rekordboxExportService.generateRekordboxXml(
        t, root,
        (done, total, phase) => send('library:progress', {
          done, total, phase: 'rekordbox', label: phase,
        }),
      );
      appState.rekordboxXmlPath = xmlPath;
      return ok({ xmlPath, entries: t.length });
    } catch (e) { return fail(e); }
  });
}

module.exports = { register };
