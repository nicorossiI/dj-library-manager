# assets/bin/

Binari nativi bundled con l'app.

## fpcalc (Chromaprint)

Scarica da https://acoustid.org/chromaprint la versione 1.5.x e metti in questa cartella:

- Windows: `fpcalc.exe`
- macOS: `fpcalc-mac` (rinomina `fpcalc` → `fpcalc-mac`)
- Linux: `fpcalc` (supportato via `fingerprintService.getFpcalcPath`)

I binari non sono inclusi nel repo per evitare problemi di licenza/dimensione.

## electron-builder

Il file `electron-builder.yml` è configurato per trasportare automaticamente
il contenuto di `assets/bin/` in `process.resourcesPath/bin/` nell'exe packaged.
