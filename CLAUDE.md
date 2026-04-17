# DJ Library Manager — Istruzioni operative

## Modalità di lavoro
- Esegui SEMPRE in modalità autonomous execution
- NON chiedere mai conferme prima di modificare file
- NON fare mai domande intermedie
- NON aspettare approvazioni
- Esegui, completa, riporta solo il risultato finale

## Regole assolute
- Modifica direttamente i file senza chiedere
- Installa npm packages senza chiedere
- Crea nuovi file senza chiedere
- Sovrascrivi file esistenti senza chiedere
- Se hai dubbi su come fare una cosa: 
  scegli tu l'opzione più semplice e vai avanti

## Stack del progetto
- Electron + Node.js (main process)
- HTML/CSS/JS vanilla (renderer)
- Nessun framework frontend
- electron-store per config in AppData
- ffmpeg-static + fpcalc per audio
- ACRCloud per riconoscimento tracce
