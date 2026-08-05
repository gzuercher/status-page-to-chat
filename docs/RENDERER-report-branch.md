# Renderer erweitern: `report.*`-Zweig in der Logic App

**Muss ausgeführt werden, bevor der erste Stabilitätsbericht fällig wird.**

Der `teamsJson`-Modus sendet ab sofort einen neuen Event-Typ `report.weekly` / `report.monthly` /
`report.quarterly`. Die Logic App **`status-pages-feed`** (Resource Group `rg-teams-feeds`) verzweigt
bisher nur mit

```
If  startsWith(triggerBody()?['event'], 'incident')   → Incident-Karte
else                                                   → Adapter-Karte
```

Ein Report-Event fiele damit in den `else`-Zweig und würde als **Adapter-Karte mit leeren Feldern**
gerendert. Deshalb braucht der Renderer einen eigenen Zweig.

## Dringlichkeit

Nicht akut, aber terminiert. Beim ersten Start nach dem Deployment ist **kein** Bericht fällig — der
Scheduler merkt sich still die laufenden Perioden (siehe `dueReports()` in `src/lib/report.ts`). Der
erste echte Bericht ist der **Wochenbericht am Montag**. Bis dahin muss der Patch stehen.

## Was der Patch tut

Rein additiv. Der bestehende Incident-Zweig bleibt unverändert; der Adapter-Zweig rutscht eine Ebene
tiefer hinter einen neuen Test:

```
If  startsWith(event, 'incident')       → Set_card_incident      (unverändert)
else
    If  startsWith(event, 'report')     → Set_card_report        (neu)
    else                                 → Set_card_adapter      (unverändert)
```

Die Report-Karte liest ausschliesslich vorgerenderte Felder (`title`, `summary`, `rankingHeading`,
`stillOpenNote`) plus das `providers`-Array. Das Ranking wird per `select(...)` in ein `FactSet`
übersetzt — mit `setProperty` statt String-Verkettung, damit ein Anführungszeichen in einem
Dienstnamen das JSON nicht zerlegen kann.

## Ausführen

Die fertigen Dateien liegen unter `/opt/stacks/raptus-status-notifs/logicapp-patch/`:

| Datei | Inhalt |
|---|---|
| `logicapp-backup.json` | vollständiger Stand **vor** dem Patch (Rollback-Quelle) |
| `logicapp-new-definition.json` | die neue `definition` |
| `patch-body.json` | fertiger Request-Body (`{"properties":{"definition":…}}`) |

```bash
ID=$(az logic workflow show -g rg-teams-feeds -n status-pages-feed --query id -o tsv)

az rest --method patch \
  --url "${ID}?api-version=2019-05-01" \
  --headers Content-Type=application/json \
  --body @/opt/stacks/raptus-status-notifs/logicapp-patch/patch-body.json
```

`PATCH` mit nur `properties.definition` lässt `properties.parameters` — und damit die
Teams-Connection — unangetastet. Ein `PUT` bzw. `az logic workflow create` würde die Connection
überschreiben; nicht verwenden.

## Prüfen

```bash
# Struktur: der Incident-Zweig muss unverändert sein, der Report-Zweig neu
az logic workflow show -g rg-teams-feeds -n status-pages-feed \
  --query 'definition.actions.Route_by_event.else.actions' -o json

# Testkarte senden (echte Daten der letzten Woche)
docker exec raptus-status-notifs node dist/src/main.js report weekly
```

Erwartete Karte: Kopfzeile „📊 STATUS-PAGES", Titel „Wochenbericht KW nn/jjjj", darunter die
Zusammenfassung und ein Ranking der betroffenen Dienste.

## Rollback

```bash
python3 -c "import json;d=json.load(open('/opt/stacks/raptus-status-notifs/logicapp-patch/logicapp-backup.json'));json.dump({'properties':{'definition':d['definition']}},open('/tmp/rollback.json','w'))"
az rest --method patch --url "${ID}?api-version=2019-05-01" \
  --headers Content-Type=application/json --body @/tmp/rollback.json
```
