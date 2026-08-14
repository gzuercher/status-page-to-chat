# Nachzuführen in social-to-chat: healthTracker

> **Status: erledigt (2026-08-14).** Beide Punkte sind in `social-to-chat` angekommen —
> `formatDuration` mit Commit `403ba35`, die zwei `httpClient`-Härtungen mit `1a67275`. Die Datei
> bleibt als Nachweis stehen, welche Änderungen bewusst **nicht** portiert wurden und warum;
> beim nächsten Spiegel-Abgleich ist das der teuerste Teil des Wissens.
>
> Nach dem Abgleich unterscheiden sich die `httpClient.ts` der beiden Repos noch in genau zwei
> Punkten, beide legitim: `REPO_URL` samt abgeleitetem Fallback-User-Agent, und `httpPost`
> akzeptiert in `social-to-chat` zusätzlich einen String-Payload (die OAuth-Endpunkte von LinkedIn
> und TikTok erwarten form-encodierte Bodies; hier gibt es keinen solchen Aufrufer). Das steht
> jetzt auch im Kopfkommentar der dortigen Datei — vorher behauptete er, nur `REPO_URL` weiche ab.

**Anlass:** PR #65 in status-page-to-chat ändert `src/lib/healthTracker.ts`. Das Modul trägt in
beiden Repos den Marker `GESPIEGELTES MODUL` und muss synchron gehalten werden.

**Kurzfassung: Es ist genau *eine* der drei Änderungen zu übernehmen.** Die anderen beiden dürfen
**nicht** portiert werden — sie würden die half-dead-Erkennung in social-to-chat stilllegen.

---

## 1. ÜBERNEHMEN: `formatDuration` sprachneutral machen

**Datei:** `src/lib/healthTracker.ts`, Funktion `formatDuration` (dort ca. Z. 278–294)

Ersetze im Tages-Zweig:

```ts
  if (days >= 1) {
    return days === 1 ? "1 day" : `${days} days`;
  }
```

durch:

```ts
  if (days >= 1) {
    return `${days}d`;
  }
```

Und ergänze den Doc-Kommentar der Funktion um die Begründung:

```ts
/**
 * Formats an elapsed millisecond value as a short human label, e.g.
 * "2h 15min", "30min", "7d".
 *
 * Deliberately language-neutral: the label is substituted into sentences
 * that are themselves localised, so a spelled-out "7 days" would read as
 * English inside a German sentence.
 */
```

**Warum das dort besonders zählt:** In social-to-chat werden die Sätze direkt in
`src/poller.ts` (`healthEventToOps`, ca. Z. 141–164) gebaut und sind **deutsch**. Aktuell steht dort
also wörtlich „liefert seit **7 days** keinerlei Beiträge" und „Polling schlägt seit **1 day** fehl".
Nach der Änderung: „seit 7d", „seit 1d".

**Test anzupassen:** `tests/lib/healthTracker.test.ts`, Block `formatDuration` (ca. Z. 198–215),
nur die letzten beiden Zeilen:

```ts
  expect(formatDuration(24 * 60 * 60_000)).toBe("1d");        // vorher "1 day"
  expect(formatDuration(7 * 24 * 60 * 60_000)).toBe("7d");    // vorher "7 days"
```

`tests/poller.test.ts` prüft keine `durationLabel`-Strings und ist nicht betroffen.

---

## 2. NICHT ÜBERNEHMEN: `configDrift`

In status-page-to-chat bekam `PollOutcome` ein Feld `configDrift`, `ProviderState` ein gleichnamiges
Feld, und `checkHalfDead` eine zusätzliche Guard-Zeile:

```ts
    if (!state.configDrift) return null;
```

**Das darf in social-to-chat nicht übernommen werden.** Dort gibt es keine Filter-Konfiguration —
`configDrift` könnte nie `true` werden, und der Guard würde half-dead **dauerhaft abschalten**.

Die Änderung löst ein Problem, das es nur im Schwester-Repo gibt: dort filtert `componentFilter`
Incidents weg, und ein stale gewordener Filter macht einen Provider dauerhaft stumm, ohne dass ein
Fehler auftritt. Ausserdem ist die Ausgangslage umgekehrt: bei status-page-to-chat sind null
Incidents der **Normalfall** (eine gesunde Statusseite meldet nichts), bei social-to-chat liefert
`fetchPosts()` das Sichtfenster, also praktisch bei jedem Lauf Items. Null Items ist dort tatsächlich
ein Defektsignal — die ursprüngliche half-dead-Logik ist dort richtig.

## 3. NICHT ÜBERNEHMEN: `logoUrl`

`PollResult` und die `HealthEvent`-Varianten haben in status-page-to-chat ein optionales `logoUrl`
bekommen. social-to-chat hat kein Logo-Feld im `OpsEvent` und braucht es nicht.

---

## 4. Header-Kommentar ergänzen

Damit die nächste Session nicht erneut abwägen muss, den Kopf von
`src/lib/healthTracker.ts` um den zweiten bewussten Unterschied erweitern — im Anschluss an den
bestehenden Hinweis zu `hasItems`/`hasIncidents`:

```
 * Zweiter bewusster Unterschied: status-page-to-chat kennt zusätzlich
 * `configDrift` und meldet half-dead nur noch auf dieses Verdikt. Hier
 * bleibt es beim Item-Kriterium — es gibt keine Filterkonfiguration, die
 * stale werden könnte, und fetchPosts() liefert das Sichtfenster, also
 * bei gesunder Konfiguration praktisch immer Items.
```

---

## 5. Prüfen nach der Änderung

```bash
pnpm build && pnpm lint && pnpm test
```

Erwartung: grün, mit den zwei angepassten `formatDuration`-Assertions.

## Ebenfalls nachzuziehen: `lib/httpClient.ts`

Zwei Härtungen aus dem Security-Review vor v0.4.0:

1. **Antwortgrösse begrenzen.** `attemptOnce` liest den Body neu über `readCapped()` statt
   `response.text()`; über `MAX_RESPONSE_BYTES` (5 MB) bricht es mit
   `Response exceeds N bytes` ab. Ohne Obergrenze bestimmt die Gegenstelle, wie viel Speicher wir
   belegen.
2. **Webhook-URL nicht ins Log.** `requestWithRetry` bekommt einen Parameter `logUrl: boolean`;
   `httpGet` übergibt `true` (dort ist die URL die nützlichste Diagnose), `httpPost` `false`,
   weil die Webhook-URL eine SAS-Signatur tragen kann — und ein gedrosselter Webhook (429) ist
   genau der Fall, der diese Zeile schreibt. Im Log steht dann `[redacted]`.

Beides ist in `social-to-chat` genauso anwendbar; die Datei unterscheidet sich dort nur in der
`REPO_URL`-Konstante.

## Nicht betroffen

`src/lib/errorCategory.ts` wurde nicht angefasst.
