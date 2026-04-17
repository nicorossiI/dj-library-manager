# assets/

Questa cartella contiene risorse bundled con l'app.

## Elementi richiesti (DA AGGIUNGERE MANUALMENTE)

### `icon.ico`
Sostituisci il placeholder con un'icona `.ico` valida 256x256 (con multi-size per Windows).
Generatori online: https://www.icoconverter.com/ oppure ImageMagick:
```bash
magick convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

### `bin/fpcalc.exe`
Binary Chromaprint necessario per il fingerprinting acustico.

1. Scarica Chromaprint 1.5.x da: https://acoustid.org/chromaprint
2. Estrai `fpcalc.exe` in `assets/bin/fpcalc.exe`
3. (Opzionale macOS) `fpcalc-mac` in `assets/bin/fpcalc-mac`

In produzione il binary viene trasportato in `process.resourcesPath/bin/` grazie
alla config `extraResources` di `electron-builder.yml`. In sviluppo viene letto
direttamente da questa cartella.
