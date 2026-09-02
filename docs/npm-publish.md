# Pubblicare `sandoichi` su npm

`sandoichi` è la libreria JavaScript opzionale di Sando. Il prodotto principale è il plugin installabile dai marketplace Claude Code e Codex.

## Stato corrente

- Pacchetto pubblicato: `sandoichi@0.4.1`
- Candidato locale: `sandoichi@0.4.2`
- Tag: `latest`
- Directory sorgente: `packages/sando/`
- Root package: privato e non pubblicabile
- Node richiesto: `>=22.22.0 <23`
- Entry point: `index.mjs`
- Dipendenze runtime: nessuna
- Licenza: MIT

Verifica lo stato del registry senza esporre credenziali:

```sh
npm view sandoichi version dist-tags --json
```

## Preparare la prossima release

Dalla root del repository:

```sh
npm run sync:bundles
npm run test:package
npm run test:benchmark
npm run test:bundles
npm run check
npm run check:gateway
python3 -m unittest scripts/test_weekly_report.py
git diff --check
test -z "$(git ls-files 'handoffs/**')"
npm run canary:smoke
```

Prima del publish, verificare nel collector self-hosted la pipeline pubblica: la
coda può contenere righe v1 e v2 durante il rollout e il collector deve
accettarle entrambe.

Poi controlla il contenuto del tarball e pubblica dalla directory del package:

```sh
cd packages/sando
npm pack --dry-run --json
npm publish --access public
npm view sandoichi version dist-tags --json
```

Applicare il bump semantico solo dopo aver confermato la versione candidata e
ripetere tutti i gate sul commit locale esatto. Il publish, il tag e la release
GitHub restano operazioni separate che richiedono autorizzazione esplicita.

Se npm richiede autenticazione, usa `npm login` nel terminale. Non inserire token nei file del repository.

Non eseguire `npm publish` dalla root: il package root è privato. Il package pubblico è `packages/sando`.
