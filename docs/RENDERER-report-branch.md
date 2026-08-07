# Renderer: der `report.*`-Zweig in der Logic App

**Status: erledigt und in Produktion.** Diese Datei hält nur noch fest, wie die Berichtskarte
zustande kommt und woran man beim nächsten Umbau denken muss.

Die Logic App **`status-pages-feed`** (Resource Group `rg-teams-feeds`) wird per Bicep aus
`raptus-integration-router` deployt — `integrations/status-pages/main.bicep` lädt die Definition mit
`loadJsonContent('workflow.json')`. **Nie direkt per `az rest` patchen:** der nächste Bicep-Deploy
überschreibt das still, und gemerkt wird es erst, wenn eine Karte ausbleibt.

## Wie die Karte gebaut wird

Der Workflow verzweigt dreifach:

```
If  startsWith(event, 'incident')   → Set_card_incident
else
    If  startsWith(event, 'report') → Set_card_report
    else                             → Set_card_adapter
```

Die Berichtskarte wird **vollständig im Renderer** aus den Rohdaten des Envelopes gebaut — Titel,
Zusammenfassung, Ranglistenzeilen und die Liste stummer Quellen. Der Envelope (`schemaVersion: 3`,
siehe [CONFIGURATION.md](CONFIGURATION.md)) liefert nur noch Zahlen; einzige Ausnahme ist
`downtimeLabel`, weil die Ausdruckssprache der Logic Apps Millisekunden nicht formatieren kann.

## Drei Fallstricke, die je einen fehlgeschlagenen Lauf gekostet haben

1. **`select()` existiert in der Workflow Definition Language nicht** — das ist eine
   Power-Automate-Funktion. WDL hat überhaupt keine map-Funktion. Listen entstehen über
   `Initialize variable` → `Foreach` mit `runtimeConfiguration.concurrency.repetitions: 1` (sonst
   ist die Sortierung dahin) → `Append to array variable`. Niemals JSON per String-Verkettung
   bauen: ein Anführungszeichen in einem Dienstnamen zerlegt es.
2. **`"@{expr}"` interpoliert zu einem String, `"@expr"` liefert den nativen Typ.** Für Arrays und
   Zahlen immer die Form ohne geschweifte Klammern.
3. **Logic Apps validieren Ausdrücke erst zur Laufzeit.** Ein `Succeeded` von
   `az deployment group create` beweist nichts.

## Nach jedem Deploy prüfen

```bash
SUB=8d902705-1e79-4d3b-a08e-b20396bcd312
BASE="https://management.azure.com/subscriptions/$SUB/resourceGroups/rg-teams-feeds/providers/Microsoft.Logic/workflows/status-pages-feed"

az rest --method get --url "$BASE/runs?api-version=2016-06-01&\$top=1" \
  --query 'value[0].{status:properties.status,error:properties.error.message}'

# bei Failed die schuldige Aktion:
RUN=$(az rest --method get --url "$BASE/runs?api-version=2016-06-01&\$top=1" --query 'value[0].name' -o tsv)
az rest --method get --url "$BASE/runs/$RUN/actions?api-version=2016-06-01" \
  --query 'value[?properties.status==`Failed`].{name:name,err:properties.error.message}'
```

Eine echte Karte auslösen:

```bash
docker exec raptus-status-notifs node dist/src/main.js report weekly
```

## Konventionen des Router-Repos

`card.json` (Design-/Testvorlage) und der WDL-Teil in `workflow.json` müssen synchron bleiben — die
CI prüft beides, dazu das Kartenlayout gegen `docs/CONVENTIONS.md`. Der Kopf braucht genau ein
ColumnSet aus drei Spalten; die Berichtskarte führt bewusst **keinen** Status-Chip, weil ein Bericht
keinen Zustand hat.

## Offen

Der Half-dead-Text im Renderer beschreibt noch die alte Semantik („kein gemeldeter Incident passte
zum Filter"). Seit der Überarbeitung feuert die Karte nur, wenn der `componentFilter` auf keine
publizierte Komponente mehr passt — `card.json` und `workflow.json` sollten den Wortlaut aus
`src/lib/i18n.ts` übernehmen.
