# Würmer töten

Eigenes, rundenbasiertes Artillerie-Spiel für den Browser. 2 bis 4 Teams kleiner Pilze, zerstörbares Gelände mit Höhlen, Wind, fünf Waffen. Online-Multiplayer ohne eigenen Server (PeerJS, ein Browser ist Gastgeber) oder alle zusammen an einem Gerät.

## Spielen

- **Online:** Namen und Raumnamen eingeben, „Raum erstellen“, Einladungslink an Freunde schicken. Optional mit Passwort.
- **An einem Gerät:** „An diesem Gerät spielen“, in der Lobby Teams hinzufügen und abwechselnd spielen.
- **Testmodus:** `?local` an die Adresse hängen. Dann laufen Räume nur zwischen Tabs desselben Browsers (BroadcastChannel), ganz ohne Internet. `?local&desync` lässt beim Mitspieler absichtlich einen Krater weg, um die Prüfsumme und den Neuabgleich zu testen.

Jede Partie bekommt eine neu erzeugte Karte (Höhlen, Hügel oder Inseln). Mit einer festen Saat in der Lobby lässt sich eine Karte wiederholen.

### Steuerung

| Taste | Aktion |
|---|---|
| ← → | laufen |
| ↑ ↓ | zielen |
| Leertaste halten | Stärke laden, loslassen schießt |
| Enter | springen |
| 1–5 | Waffe wählen |
| F | Zünderzeit (Knallei) |
| T | Chat öffnen (Esc schließt) |
| Maus ziehen, Mausrad, + − | Kamera bewegen und zoomen |
| M | Ton an/aus |

Auf dem Handy gibt es Touch-Knöpfe.

### Waffen

| Waffe | Verhalten |
|---|---|
| Rakete | fliegt mit dem Wind, explodiert beim Aufprall |
| Knallei | springt, explodiert nach 1–5 s |
| Streukürbis | platzt in fünf Kerne (2 pro Partie) |
| Schrotflinte | gerader Schuss ohne Bogen |
| Sprengfass | wird abgestellt, 4 s Zünder (1 pro Partie) |

## Lokal starten

Die Seite braucht einen Webserver (ES-Module laufen nicht über `file://`):

```sh
npm start        # python3 -m http.server 8080
npm test         # Node-Tests für Gelände und Spiellogik
```

Dann `http://localhost:8080/` bzw. `http://localhost:8080/?local` öffnen.

## Veröffentlichen

Der Workflow `.github/workflows/pages.yml` testet jeden Push und veröffentlicht `main` auf GitHub Pages (mit `version.txt`). Einmalig nötig: Repository-Einstellungen → Pages → Source „GitHub Actions“.

## Aufbau

| Datei | Inhalt |
|---|---|
| `js/terrain.js` | Gelände-Maske, Krater, RLE, Prüfsumme, Kartengenerator (ohne DOM) |
| `js/game.js` | Phasen, Züge, Physik, Waffen, Schnappschuss, Ereignisse (ohne Netzwerk und DOM) |
| `js/net.js` | PeerJS und BroadcastChannel hinter einer gemeinsamen Schnittstelle |
| `js/session.js` | Gastgeber und Mitspieler: Lobby, Protokoll, Schleifen, Wiederverbinden |
| `js/view.js` | Zeichnen aus Schnappschüssen und Ereignissen |
| `js/ui.js` | Menü, Lobby, HUD, Eingabe, Töne |
| `vendor/peerjs.min.js` | PeerJS 1.5.4 (MIT), mitgeliefert statt CDN |

Das Konzept steht in [`docs/online-multiplayer.md`](docs/online-multiplayer.md).
