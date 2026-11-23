# Terrablox Intro – interne Vorstellung

Die Präsentation für die MHP AWS Community. Reines HTML, CSS und JavaScript ohne
Build-Schritt und ohne externe Abhängigkeiten: `index.html` im Browser öffnen genügt,
auch offline.

```bash
open presentation/intro/index.html
```

## Bedienung

| Taste | |
| --- | --- |
| `→` `Leertaste` `Enter` | Nächster Schritt, dann nächster Slide |
| `←` | Zurück |
| `↓` `↑` | Nächster / vorheriger Slide, ohne die Schritte |
| `O` | Übersicht aller Slides, zum Springen |
| `N` | Skript ein- und ausblenden |
| `F` | Vollbild |

Das Skript ist der gesprochene Text pro Slide. Bei Slides mit mehreren Klicks gehört jeder
Absatz zu einem Klick: der aktuelle ist hervorgehoben, ein `→` davor heißt „erst klicken,
dann sagen". Text in eckigen Klammern ist eine Regieanweisung. Das Skript liegt über dem
Slide – wer den Bildschirm teilt, zeigt es mit.

Die URL merkt sich Slide und Schritt (`#8.4`), ein Reload landet also an derselben
Stelle. Auf Slide 9 spielt *Abspielen* die Migration von selbst durch.

## Vor dem Vortrag anpassen

Ganz oben in `deck.js` steht ein optionaler Name. Leer gelassen, erscheint auf dem
Titelslide nichts dazu.

```js
const DECK = {
  presenter: "", // Name auf dem Titelslide
};
```

## Als PDF

Im Browser drucken (`Cmd` + `P`) und als PDF sichern. Jeder Slide wird eine Seite im
Format 16:9, mit allen Schritten im Endzustand. In Chrome *Hintergrundgrafiken*
aktivieren, sonst fehlen die dunklen Slides.

## Aufbau

Die Storyline hat vier Teile, und der dritte kehrt zum ersten zurück:

1. **These** – AI wird Standard, die eigenen Daten bleiben der Unterschied.
2. **Idee** – Der Agent editiert einen Modell-Graphen statt Code zu schreiben.
3. **Daten** – Jeder Turn fällt als Transformation heraus, und damit schließt sich der
   Kreis zur These.
4. **Mitmachen** – Lokal ausprobieren, Open Source mitbauen und den nächsten Schritt
   Richtung zentralem Hosting angehen.

Die Screenshots in `assets/screenshots/` stammen aus dem laufenden Dashboard, die Icons in
`assets/icons/` sind Kopien aus `apps/website/public/module-icons/` im Repository. Der Ordner kann damit
für sich allein weitergegeben werden.
