# Online-Multiplayer für das Artillerie-Spiel (Konzept)

Stand: 7. November 2026 · Arbeitsdokument, Ablageort noch offen

Grundlage ist die BombRe-Anleitung „Online-Multiplayer im Browser ohne eigenen Server“ (PeerJS, Gastgeber rechnet alles, Stern-Verbindung). Dieses Dokument zeigt, was davon für ein rundenbasiertes Artillerie-Spiel mit zerstörbarem Gelände direkt passt, was angepasst werden muss und was neu dazukommt.

Das Spiel ist ein **eigenes** Spiel im Genre (Teams aus kleinen Figuren, Zielen mit Winkel und Stärke, Wind, Krater im Gelände). Namen, Figuren, Grafiken, Waffennamen und Musik denken wir uns selbst aus und übernehmen nichts aus bestehenden Spielen. Im Text steht deshalb nur „Arbeitstitel“ und „Figur“.

---

## 1. Kurzfassung

- **Die Architektur von BombRe bleibt.** Ein Browser ist Gastgeber, rechnet Physik, Schaden und Zugreihenfolge und schickt den Stand an alle. Die anderen schicken nur Eingaben.
- **Rundenbasiert macht vieles leichter.** Pro Zug darf nur ein Spieler etwas tun. Eingaben der anderen werden ignoriert. Verzögerung ist kaum spürbar, weil niemand gegen die Zeit eines anderen reagieren muss.
- **Jede Partie hat eine neue, zufällige Karte.** Der Gastgeber erzeugt sie beim Start mit einer frischen Saat.
- **Das Gelände wird nie als ganzes Bild in jedem Schnappschuss geschickt.** Es kommt einmal beim Spielstart (kompakt als Höhenprofil oder RLE-Bitmap), danach nur noch als Liste von Kratern (`x, y, r`). Jeder Browser rechnet die Krater selbst ins Gelände ein.
- **Explosionen, Krater und Schaden sind Ereignisse, keine Zustände.** Sie gehen mit Laufnummer über die zuverlässige Verbindung, damit kein Krater zwischen zwei Schnappschüssen verloren geht.
- **Der Schuss ist eine einzige Aktion.** Der Mitspieler zielt und lädt die Stärke lokal auf und schickt beim Loslassen `fire` mit Winkel, Stärke und Waffe. Dadurch spielt die Verzögerung beim Aufladen keine Rolle.
- **Gastgeber weg ist bei einem Rundenspiel reparierbar.** Der komplette Spielstand zu Zugbeginn ist klein (wenige KB). Wenn der Gastgeber ihn jedem Mitspieler schickt, kann später ein Mitspieler übernehmen (Stufe 2, optional).

---

## 2. Rundenbasiert oder Echtzeit?

| | Rundenbasiert (Empfehlung) | Echtzeit (alle gleichzeitig) |
|---|---|---|
| Wer handelt | Nur die aktive Figur | Alle Figuren |
| Spürbare Verzögerung | Nur beim Laufen der eigenen Figur, 30–100 ms | Bei allem, bräuchte Client-Vorhersage |
| Netzlast | Gering, in Wartephasen fast null | Hoch, durchgehend 20 Hz |
| Gastgeber-Übergabe | Machbar (Stand zu Zugbeginn) | Sehr schwer |
| Passt zum Genre | Ja, klassisch | Eigene Variante, später denkbar |

**Empfehlung:** rundenbasiert mit Zug-Timer. Die BombRe-Schleife (60 Hz rechnen, 20 Hz senden) wird übernommen, aber die Sendehäufigkeit hängt von der Phase ab (siehe Abschnitt 6).

Nebeneffekt: Weil `Game` nichts vom Netzwerk weiß, gibt es **Hotseat** (mehrere Spieler an einem Gerät) fast gratis. Das ist auch der beste Weg, die Spiellogik ohne Netzwerk zu testen.

### Ablauf eines Zuges (Phasen)

```
lobby → start → [ aim → shot → settle → retreat → next ] … → over
```

| Phase | Was passiert | Timer |
|---|---|---|
| `aim` | Aktive Figur läuft, springt, wählt Waffe, zielt | Zug-Timer läuft (z. B. 45 s) |
| `shot` | Geschoss(e) fliegen | Zug-Timer pausiert |
| `settle` | Figuren fallen, rutschen, Schaden wird angezeigt | Bis alles ruht, maximal z. B. 8 s |
| `retreat` | Kurze Zeit zum Weglaufen nach dem Schuss | z. B. 3 s |
| `next` | Wasser/Absturz prüfen, Sieger prüfen, nächstes Team, neuer Wind | sofort |

Nur der Gastgeber wechselt die Phase. Mitspieler sehen sie im Schnappschuss.

---

## 3. Zerstörbares Gelände synchronisieren

Das ist der wichtigste Unterschied zu BombRe. Dort ist das Feld ein kleines Raster (`grid.join('')`), das in jeden Schnappschuss passt. Ein Pixel-Gelände von z. B. 1600 × 800 hat 1,28 Millionen Pixel. Das geht nicht 20-mal pro Sekunde über die Leitung.

### Jede Partie bekommt eine neue Karte

Die Karte wird **bei jedem Spielstart neu erzeugt, und zwar nur auf dem Gastgeber.** Die Mitspieler erzeugen nichts selbst, sie bekommen das fertige Ergebnis (siehe „Was übertragen wird“, Variante B). Dadurch spielt es keine Rolle, ob ihr Browser anders rechnet.

Ablauf beim Klick auf „Spiel starten“:

1. Der Gastgeber würfelt eine neue Saat: `seed = crypto.getRandomValues(new Uint32Array(1))[0]`.
2. Ein eigener PRNG (z. B. mulberry32) wird mit dieser Saat gestartet. Alles Zufällige der Karte kommt aus ihm, nie aus `Math.random()`.
3. Der Generator baut die Maske in Schritten:
   - **Grundform:** ein Höhenprofil aus mehreren überlagerten Wellen bzw. Midpoint-Displacement (Hügel, Täler, Plateaus). Wasserlinie am unteren Rand.
   - **Optional Höhlen und Inseln:** Rauschen (z. B. Value-Noise) oder ein paar zufällige „Ausstanz“-Kreise und Tunnel, danach kleine schwebende Brocken unter einer Mindestgröße entfernen.
   - **Stil/Thema** zufällig oder in der Lobby gewählt (Textur, Hintergrund, Farbe). Das betrifft nur das Aussehen und wird als kleine Kennung mitgeschickt.
4. **Startplätze** für alle Figuren: zufällige Spalten mit festem Boden darunter, genug Abstand zueinander und zum Wasser, nicht in einer Höhle eingeschlossen. Findet der Generator nicht genug Plätze (z. B. nach 200 Versuchen), wirft er die Karte weg und würfelt eine neue Saat.
5. Der Gastgeber schickt in `start`: fertige Maske (Höhenprofil oder RLE), Startplätze, Thema und die Saat.

Die Saat wird nur mitgeschickt, damit man eine schöne Karte später wieder aufrufen kann („Karte nochmal spielen“, auf dem Gastgeber). Zum Nachbauen beim Mitspieler wird sie nicht benutzt.

Einstellungen in der Lobby (gehen mit `lobby` an alle, wirken nur auf dem Gastgeber):

| Einstellung | Werte (Vorschlag) |
|---|---|
| Kartengröße | klein / mittel / groß |
| Geländeart | Hügel / Insel / Höhlen |
| Thema | zufällig oder fest |
| Saat | leer = zufällig, sonst feste Zahl (zum Wiederholen) |

### Darstellung im Speicher

- Gelände als **Maske**: `Uint8Array(W * H)`, 1 = fest, 0 = Luft. Gezeichnet wird über ein Offscreen-Canvas mit Textur, die Maske dient nur für Kollision.
- Ein Krater ist „setze alle Pixel im Kreis um (x, y) mit Radius r auf 0“. Mit **ganzzahligen** `x, y, r` ergibt das in jedem Browser exakt dasselbe Ergebnis.

### Was übertragen wird

1. **Beim Spielstart einmal das Grundgelände.** Zwei Möglichkeiten:
   - **A) Saat (Seed) + Generator.** Nur eine Zahl. Risiko: Der Generator muss in allen Browsern bitgenau gleich rechnen. `Math.sin`, `Math.pow` und Co. sind nicht garantiert identisch zwischen Chrome, Firefox und Safari. Geht nur mit eigenem PRNG (z. B. mulberry32) **und** reiner Ganzzahl-Rechnung im Generator.
   - **B) Fertiges Gelände kompakt schicken (Empfehlung).** Der Gastgeber erzeugt das Gelände und schickt es einmal:
     - Höhenprofil (eine Höhe pro Spalte, `Uint16Array(W)`): 1600 Spalten = 3,2 KB. Reicht für Hügel ohne Höhlen.
     - Oder RLE-kodierte Maske (Läufe von 0/1 pro Zeile): typisch 10–40 KB, erlaubt Höhlen, Inseln, Überhänge.

     PeerJS verschickt `ArrayBuffer`/`Uint8Array` direkt binär. Einmalig 40 KB beim Start sind unproblematisch.
   Empfehlung B, weil es keine Determinismus-Falle gibt. Die Saat kann trotzdem mitgeschickt werden, um eine Karte später wieder zu erzeugen (nur auf dem Gastgeber).

2. **Während des Spiels nur Krater.** Jede Explosion erzeugt ein Ereignis `[seq, x, y, r]` (Abschnitt 5). Die Mitspieler wenden es auf ihre eigene Maske an. 16 Bytes statt Megabytes.

3. **Prüfsumme gegen Abweichungen.** Am Ende jeder `settle`-Phase schickt der Gastgeber einen kurzen Hash der Maske (z. B. FNV-1a über alle Bytes, ein paar ms). Weicht der eines Mitspielers ab, fragt er `resync` an und bekommt das ganze Gelände neu (wie beim Start). Das fängt Fehler ab, ohne dass sie das Spiel kaputt machen.

4. **Späteinsteiger und Wiederverbinden** bekommen Grundgelände + alle bisherigen Krater (oder direkt die aktuelle Maske als RLE).

### Was sonst noch das Gelände ändert

Alles, was Gelände **hinzufügt** (z. B. eine Baustein-Waffe, Brücken), wird genauso als Ereignis geschickt: `[seq, 'add', x, y, form]`. Die Regel ist: **Jede Geländeänderung ist ein Ereignis mit ganzzahligen Werten**, nie ein Pixelbild.

---

## 4. Projektil-Physik

- **Nur der Gastgeber rechnet** Flug, Wind, Schwerkraft, Abprall, Zünder und Treffer, mit fester Schrittweite `TICK = 1/60` (wie in BombRe).
- Kollision Projektil ↔ Gelände: Pixel der Maske an der Projektilposition prüfen; bei schnellen Geschossen pro Tick in Teilschritten (z. B. 4 Teilschritte), damit nichts durch dünne Wände tunnelt.
- Explosion: Krater erzeugen, Schaden nach Abstand für alle Figuren im Radius, Rückstoß als Geschwindigkeit auf die Figuren. Danach fallen Figuren in `settle`.
- **Darstellung beim Mitspieler:** Geschosspositionen kommen mit dem Schnappschuss (20 Hz) und werden wie die Spielfiguren in BombRe geglättet. Für flüssigere Flugbahnen kann der Mitspieler zusätzlich **lokal vorausrechnen**: Er kennt Startpunkt, Geschwindigkeit, Wind und Schwerkraft und berechnet die Bahn selbst. Jeder Schnappschuss korrigiert die Position. Das ist reine Optik, die Entscheidung über Treffer trifft immer der Gastgeber.
- Zufall (Streuung, Splitter, Kistenabwurf) nur auf dem Gastgeber mit einem eigenen PRNG. So ist ein Spiel aus Saat + Eingaben später auch als Wiederholung abspielbar (optional).

---

## 5. Zustand und Ereignisse

BombRe schickt alles als Zustand. Das reicht dort, weil eine Flamme mehrere Schnappschüsse lang sichtbar ist. Hier gibt es kurze, einmalige Dinge, die nicht verloren gehen dürfen: Krater, Explosionseffekt, Schadenszahl, Ton, „Figur ertrunken“. Darum zwei Kanäle in derselben Verbindung:

| Art | Beispiel | Wie verschickt |
|---|---|---|
| **Zustand** (`state`) | Positionen, Lebenspunkte, Timer, Wind, aktive Figur | Regelmäßig, der neueste gewinnt, darf übersprungen werden |
| **Ereignis** (`ev`) | Krater, Explosion, Schaden, Tod, Waffenkiste | Einzeln mit Laufnummer `seq`, nie überspringen, in Reihenfolge anwenden |

- Der Mitspieler merkt sich `lastSeq`. Kommt eine Lücke an (sollte bei `reliable: true` nicht passieren, kann aber nach Wiederverbinden passieren), fragt er `resync` an.
- Ereignisse können auch gebündelt im nächsten Schnappschuss mitreisen (`state.ev = [...]`). Wichtig ist nur: Ein Schnappschuss mit Ereignissen darf nicht weggelassen werden.

**Gegenstau bei schlechter Verbindung:** PeerJS mit `reliable: true` verliert nichts, staut aber auf, wenn die Leitung langsam ist. Dann kommen Schnappschüsse immer später an. Abhilfe: Vor dem Senden eines reinen Zustands-Schnappschusses `conn.dataChannel.bufferedAmount` prüfen und ihn bei z. B. über 64 KB auslassen. Ereignisse werden immer geschickt.

---

## 6. Schnappschuss-Größe

Unveränderliches (Namen, Farben, Teamzuordnung, Kartengröße, Einstellungen) geht nur einmal mit `start`. Der laufende Schnappschuss enthält nur, was sich bewegt oder ändert. Kompakt als Arrays wie in BombRe:

```js
snapshot() {
  return {
    t: 'state', ph: this.phase, turn: this.turn, act: this.activeId,
    clock: Math.ceil(this.clock), wind: Math.round(this.wind * 100),
    // [id, x, y, hp, blickrichtung, zustand]  zustand: 0 steht, 1 läuft, 2 fällt, 3 zielt
    f: this.figures.map((f) => [f.id, f.x | 0, f.y | 0, f.hp, f.dir, f.st]),
    // nur die aktive Figur: Winkel (Grad), Waffe, Ladestärke (0..100) für die Anzeige
    aim: [this.aim.ang, this.aim.weapon, this.aim.pow],
    // Geschosse: [id, art, x, y, vx, vy]
    p: this.projectiles.map((p) => [p.id, p.kind, p.x | 0, p.y | 0, Math.round(p.vx), Math.round(p.vy)]),
  };
}
```

Grobe Rechnung für 4 Spieler mit je 4 Figuren:

- 16 Figuren × ca. 25 Bytes ≈ 400 B, plus Kopf und Geschosse ≈ 500–600 B pro Schnappschuss.
- 20 Hz × 3 Mitspieler ≈ 36 KB/s Upload beim Gastgeber. Für jedes Heimnetz unkritisch.

**Sendehäufigkeit nach Phase** (spart zusätzlich):

| Phase | Senden |
|---|---|
| `lobby`, `over` | nur bei Änderung (`lobby`-Nachricht) |
| `aim` | 10–20 Hz, nur wenn sich etwas geändert hat, sonst 1 Hz als Herzschlag |
| `shot`, `settle` | 20 Hz |
| `retreat`, `next` | 10 Hz |

Gezeichnet wird beim Mitspieler weiter mit 60 Bildern pro Sekunde, Figuren und Geschosse geglättet (BombRe-Methode, 35 % pro Bild, großer Sprung = sofort hinsetzen).

---

## 7. Eingaben: Laufen, Zielen, Stärke, Waffe

Grundregel aus BombRe bleibt: **Zustand schicken, kurze Aktionen als Zähler.** Neu ist, dass ein Schuss Werte mitbringt.

```js
S.input = {
  dx: 0,         // -1 / 0 / 1 laufen
  jump: 0,       // Zähler
  ang: 45,       // Zielwinkel in ganzen Grad (−90..90, relativ zur Blickrichtung)
  weapon: 0,     // gewählte Waffe (Index)
  fire: 0,       // Zähler: jeder Schuss erhöht um 1
  pow: 0,        // Stärke beim letzten Schuss (0..100), gehört zu fire
  fuse: 3,       // Zünderzeit in s für Waffen mit Zünder (1..5)
};
```

- **Zielen sofort lokal anzeigen.** Das Fadenkreuz der eigenen Figur zeichnet der Mitspieler direkt aus seinem `S.input.ang`, nicht aus dem Schnappschuss. Das ist eine harmlose „Vorhersage“ und macht das Zielen ohne Verzögerung. Die anderen sehen den Winkel über `state.aim`.
- **Stärke lokal aufladen.** Taste halten lädt `pow` beim Mitspieler auf (Anzeige lokal). Beim Loslassen: `pow` festhalten, `fire` hochzählen, sofort senden. Würde der Gastgeber die Haltezeit messen, verfälscht die Netzverzögerung die Stärke.
- **Gastgeber prüft alles:** Ist der Absender gerade am Zug? Phase `aim`? Waffe im Inventar? Werte begrenzen (`ang` auf −90..90, `pow` auf 0..100, `fuse` auf 1..5, alles `| 0`). Eingaben von Spielern, die nicht dran sind, werden verworfen.
- Senden wie BombRe: bei Änderung und alle 250 ms. Weil `fire` ein Zähler ist, löst eine doppelte Nachricht keinen zweiten Schuss aus.
- Handy: Steuerung über Knöpfe und Ziehen am Bildschirm (Winkel per Wischen, Stärke per Halten). Das ändert nur, wie `S.input` befüllt wird, nicht das Protokoll.

---

## 8. Zug-Timer

- Nur der Gastgeber zählt. Der Schnappschuss enthält die Restzeit in ganzen Sekunden (`clock`), die Mitspieler zeigen sie nur an.
- Läuft der Timer in `aim` ab: Zug endet ohne Schuss (direkt `next`).
- Während `shot` und `settle` steht der Timer. `settle` hat eine **Obergrenze** (z. B. 8 s), damit ein ewig rollendes Objekt das Spiel nicht blockiert. Danach gilt „alles ruht“.
- **Hintergrund-Tab des Gastgebers:** Die `setInterval`-Weiterrechnung aus BombRe ist hier Pflicht, sonst bleibt der Timer stehen, wenn der Gastgeber kurz wegklickt. Browser drosseln Hintergrund-Intervalle auf etwa 1 pro Sekunde. Die `tick`-Funktion holt dann bis zu 0,25 s auf einmal nach. Für ein Rundenspiel reicht das, ruckelt aber für die Mitspieler. Hinweis in der Lobby: „Gastgeber bitte nicht wegklicken“.
- Abwesender Spieler am Zug (Verbindung weg): Zug wird übersprungen, nicht der Timer abgewartet.

---

## 9. Verbindungsabbrüche

### Mitspieler fällt raus

BombRe entfernt den Spieler einfach. Hier hätte das zur Folge, dass sein Team verschwindet. Besser:

- Team bleibt auf dem Feld, wird als „abwesend“ markiert, seine Züge werden übersprungen.
- **Wiederverbinden:** In `welcome` gibt der Gastgeber zusätzlich ein zufälliges Token mit (`tok`). Der Mitspieler speichert es in `sessionStorage` (in `try/catch`). Beim erneuten Beitreten schickt er `join` mit `tok`. Der Gastgeber findet den alten Spieler, hängt die neue Verbindung daran und schickt `sync` (vollständiger Stand). Das ist die einzige Ausnahme von „nach Spielstart kein Beitritt“.
- Nach z. B. 2 Minuten ohne Rückkehr: Team gilt als aufgegeben (Figuren bleiben als neutrale Ziele oder verschwinden, Einstellungsfrage).

### Gastgeber fällt raus

**Stufe 1 (Pflicht):** wie BombRe. Klare Meldung „Der Gastgeber hat das Spiel verlassen“, zurück zum Start. Wake-Lock und „Gastgeber am Rechner“ empfehlen.

**Stufe 2 (optional, später): Übernahme durch einen Mitspieler.** Bei einem Rundenspiel ist der Stand zu Zugbeginn klein und vollständig:

- Gelände-Maske (RLE, 10–40 KB) oder Grundgelände + Kraterliste
- Figuren (Position, Lebenspunkte), Inventare, Zugreihenfolge, Wind, Rundennummer, PRNG-Zustand

Ablauf:

1. Zu jedem Zugbeginn schickt der Gastgeber `ckpt` (Checkpoint) an alle. Die Mitspieler legen ihn nur ab.
2. In `lobby`/`start` steht eine feste **Nachfolger-Reihenfolge** (z. B. Beitrittsreihenfolge).
3. Bricht die Verbindung zum Gastgeber ab, wartet jeder Mitspieler 3 s. Der erste Nachfolger öffnet den Raum neu unter der Kennung `PRÄFIX + raum + '-' + (generation + 1)`, lädt den Checkpoint und wird Gastgeber.
4. Die anderen versuchen, diese neue Kennung zu erreichen (mit ihrem Token). Ist der Nachfolger auch weg, versucht der nächste nach weiteren 3 s.
5. Der laufende Zug wird verworfen und ab Checkpoint neu gestartet.

Aufwand: mittel. Lohnt sich erst, wenn Stufe 1 stabil läuft. Sicherheit: Jeder Mitspieler hat damit den ganzen Stand. Für ein Freunde-Spiel ist das in Ordnung (Inventare der Gegner sind sowieso meist sichtbar).

---

## 10. Nachrichten-Protokoll

Alle BombRe-Typen bleiben, einige kommen dazu. Jede Nachricht hat das Feld `t`.

**Mitspieler → Gastgeber**

| `t` | Inhalt | Wann |
|---|---|---|
| `join` | `name`, `pw` (Hash), optional `tok`, `matches` | Einmal nach dem Verbinden |
| `input` | `dx`, `jump`, `ang`, `weapon`, `fire`, `pow`, `fuse` | Bei Änderung und alle 250 ms (nur sinnvoll, wenn am Zug) |
| `team` | gewünschter Teamname, Farbe, Figurennamen | In der Lobby |
| `ready` | `0/1` | In der Lobby |
| `resync` | `lastSeq` | Bei Lücke oder falscher Prüfsumme |
| `chat` | `text` (max. 120 Zeichen) | Jederzeit (optional) |

**Gastgeber → Mitspieler**

| `t` | Inhalt | Wann |
|---|---|---|
| `welcome` | `id`, `tok` | Beitritt angenommen |
| `reject` | `reason` | Beitritt abgelehnt |
| `lobby` | `players`, `settings`, `phase` | Bei Änderung in der Lobby |
| `start` | Kartengröße, frisch erzeugtes Gelände (binär), Startplätze, Thema, Saat, Teams, Figuren-Stammdaten, Waffenliste, Nachfolger-Reihenfolge | Einmal bei Spielstart |
| `state` | Schnappschuss (Abschnitt 6), optional gebündelte `ev` | Je nach Phase 1–20 Hz |
| `ev` | `[seq, art, …]`, z. B. Krater, Explosion, Schaden, Tod, Kiste | Sofort, wenn es passiert |
| `turn` | aktive Figur, Wind, Timer-Start, Gelände-Prüfsumme des letzten Zugs | Zugbeginn |
| `ckpt` | vollständiger Stand (Stufe 2) | Zugbeginn |
| `sync` | vollständiger Stand + `lastSeq` | Auf `resync` und beim Wiederverbinden |
| `over` | Sieger, Statistik | Spielende |
| `matches` | Rangliste | Nach Beitritt und Spielende |

---

## 11. Was aus der BombRe-Vorlage wiederverwendet wird

| Teil | Übernahme | Anpassung |
|---|---|---|
| `Net.host` / `Net.join`, `wrapPeerConn` | unverändert | eigenes Präfix, z. B. `<arbeitstitel>-v1-` |
| `localHost` / `localJoin` (`?local`) | unverändert | eigenes Kanal-Präfix. Binärdaten gehen über `BroadcastChannel` problemlos |
| `slug`, `hashPw` | unverändert | eigenen Spielnamen im Hash |
| `inviteLink`, `copyInvite`, `readInvite`, Teilen-Knopf | unverändert | — |
| `onClientConnect` | Grundgerüst | Wiederverbinden mit `tok`, Eingaben nur vom Spieler am Zug, Team bleibt bei Abbruch |
| `joinRoom` | Grundgerüst | `tok` speichern/mitschicken, `start`/`ev`/`sync` behandeln |
| `runHostLoop` | Grundgerüst | phasenabhängiges Senden, `bufferedAmount`-Prüfung, Ereignisse sofort senden |
| `runClientLoop` | Grundgerüst | Fadenkreuz und Stärke lokal zeichnen, Kamera lokal |
| Glättung der Positionen | unverändert | auch für Geschosse, optional mit lokaler Flugbahn-Vorausrechnung |
| Zähler für Aktionen | Prinzip | `fire` zusammen mit `pow`/`ang` |
| `mergeMatches` (Rangliste) | unverändert | eigener `localStorage`-Schlüssel |
| Versionskennung (GitHub Actions, `version.txt`) | unverändert | — |
| `esc()`, Eingaben begrenzen | unverändert | Team- und Figurennamen und Chat ebenfalls escapen/kürzen |

**Neu zu schreiben:** Gelände-Maske mit Krater-Funktion und RLE-Kodierung, Ereignis-Warteschlange mit `seq`, Phasen/Zug-Logik, Physik, Kamera (lokal, folgt aktiver Figur bzw. Geschoss, wird nicht synchronisiert), Prüfsumme, Wiederverbinden.

---

## 12. Vorschlag für die Dateistruktur

```
index.html
style.css
net.js        // Net, wrapPeerConn, localHost, localJoin, hashPw, slug (aus BombRe)
terrain.js    // Maske, carve(x,y,r), RLE encode/decode, hash, Zeichnen über Offscreen-Canvas
game.js       // class Game: Phasen, Züge, Physik, Waffen, snapshot(), events – ohne Netzwerk
session.js    // Gastgeber/Mitspieler: onClientConnect, joinRoom, Schleifen, Protokoll
ui.js         // Lobby, Einladungslink, HUD, Eingabe (Tastatur, Touch)
assets/       // eigene Grafiken und Töne
```

`game.js` und `terrain.js` laufen ohne DOM. So lassen sie sich auch mit Node testen (z. B. „Krater in zwei Masken ergibt gleiche Prüfsumme“).

---

## 13. Reihenfolge der Umsetzung

1. **Spiel lokal (Hotseat):** Kartengenerator (jede Partie neu), Gelände, eine Waffe, Physik, Züge, Timer. Kein Netzwerk.
2. **`net.js` übernehmen, `?local` testen:** Lobby, Beitritt, `start` mit Gelände, `state` + `ev`.
3. **Prüfsumme + `resync`** einbauen und absichtlich einen Krater weglassen, um es zu testen.
4. **Über das Internet testen** mit zwei Geräten (WLAN und Mobilfunk).
5. **Wiederverbinden** mit Token.
6. Mehr Waffen, Kisten, Handy-Steuerung, Rangliste.
7. Optional: **Gastgeber-Übernahme** (Stufe 2).

---

## 14. Checkliste

Aus BombRe übernommen:

- [ ] Eigenes Peer-Präfix (`<arbeitstitel>-v1-`), eigener Name in `hashPw`, eigene Präfixe für `BroadcastChannel` und `localStorage`
- [ ] `Game` weiß nichts vom Netzwerk
- [ ] Spieler-IDs vergibt der Gastgeber
- [ ] Alles vom Mitspieler prüfen und begrenzen, Namen escapen
- [ ] Zeitgrenzen beim Verbinden und Handschlag
- [ ] Hintergrund-Tab des Gastgebers rechnet weiter
- [ ] Mit `?local` in zwei Tabs testen, dann zwei Geräte
- [ ] Versionskennung auf GitHub Pages
- [ ] Klare Fehlermeldungen (Raum existiert, existiert nicht, falsches Passwort, voll, Spiel läuft, Gastgeber weg)

Neu für das Artillerie-Spiel:

- [ ] Karte bei jedem Spielstart neu erzeugen (nur Gastgeber, frische Saat, eigener PRNG, Startplätze prüfen)
- [ ] Gelände nur einmal beim Start schicken (Höhenprofil oder RLE), danach nur Krater-Ereignisse mit ganzzahligen Werten
- [ ] Ereignisse mit Laufnummer, nie überspringen
- [ ] Gelände-Prüfsumme nach jedem Zug, `resync` bei Abweichung
- [ ] Zufall nur auf dem Gastgeber mit eigenem PRNG
- [ ] Nur Eingaben des Spielers am Zug annehmen
- [ ] Schuss als eine Aktion: `fire`-Zähler mit `ang`, `pow`, `weapon`, `fuse`
- [ ] Fadenkreuz und Stärkeanzeige lokal zeichnen
- [ ] Zug-Timer nur auf dem Gastgeber, pausiert in `shot`/`settle`, `settle` mit Obergrenze
- [ ] Sendehäufigkeit nach Phase, Zustand bei Stau (`bufferedAmount`) auslassen
- [ ] Stammdaten nur in `start`, Schnappschuss nur Bewegliches
- [ ] Mitspieler-Abbruch: Team bleibt, Züge übersprungen, Wiederverbinden mit Token
- [ ] Kamera lokal, nicht synchronisieren
- [ ] Eigene Namen, Grafiken, Töne (nichts aus bestehenden Spielen)

---

## 15. Offene Fragen

- Wo kommt das Projekt hin (eigenes Repo, Unterordner, GitHub Pages)?
- Wie viele Spieler und Figuren pro Team maximal? (Bestimmt Schnappschuss-Größe und Lobby.)
- Kartengröße und welche Geländearten der Generator können soll, vor allem ob Höhlen/Überhänge gewünscht sind (entscheidet Höhenprofil vs. RLE-Maske).
- Handy als vollwertige Plattform oder nur Rechner?
- Soll die Gastgeber-Übernahme (Stufe 2) von Anfang an eingeplant werden?
