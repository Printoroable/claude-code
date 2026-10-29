# Familienplaner 📅

Ein geteilter Familienkalender im Stil von **TimeTree** – selbst gehostet als Docker-Container.
Alle Familienmitglieder öffnen dieselbe Adresse im Browser (Handy, Tablet, PC) und sehen
Änderungen sofort live.

## Funktionen

- **Monatsansicht wie TimeTree**: mehrtägige Termine als durchgehende Farbbalken,
  Uhrzeit-Termine mit Farbmarker, „+n“ bei vollen Tagen, Wischen zum Monatswechsel
- **Tagesliste** unter dem Kalender (Handy) bzw. daneben (Desktop)
- **Familienmitglieder** mit eigener Farbe – Termine zeigen, wer dabei ist
- **Mehrere Kalender** (z. B. Familie, Schule, Arbeit), einzeln ein-/ausblendbar
- **Wiederholungen**: täglich, wöchentlich, monatlich, jährlich (z. B. Geburtstage), optional mit Enddatum
- **Kommentare** an jedem Termin („Wer fährt Lena hin?“)
- **Dokumente an Terminen**: Elternbriefe, Tickets, Einladungen, Fotos usw. anhängen –
  direkt beim Anlegen oder später in der Terminansicht (am Desktop auch per Drag & Drop).
  Bilder bekommen eine Vorschau, PDFs öffnen sich im Browser.
- **Notizen & Listen** mit Abhak-Funktion (Einkaufsliste, Packliste …), anheftbar
- **Anstehende Termine** der nächsten 60 Tage als Liste
- **Deutsche Feiertage** werden markiert
- **Live-Sync** zwischen allen Geräten (Server-Sent Events)
- **Export** aller Termine als `.ics` (Google/Apple/Outlook)
- Optionales **Familien-Passwort**, Dark Mode, als App auf dem Homescreen installierbar (PWA)

## Start mit Docker

```bash
cd familienplaner
cp .env.example .env        # Passwort in .env anpassen
docker compose up -d --build
```

Danach im Browser öffnen: <http://localhost:3000> (bzw. `http://<IP-des-Servers>:3000`
im Heimnetz, z. B. auf einem NAS oder Raspberry Pi).

Beim ersten Start unter **Familie** die Mitglieder anlegen und auswählen, wer man selbst ist.

### Fertiges Image (z. B. für eine NAS)

GitHub baut bei jeder Änderung automatisch ein fertiges Image:
**`ghcr.io/printoroable/familienplaner:latest`** (für Intel/AMD und ARM).
Am einfachsten den Inhalt von [`nas/docker-compose.yml`](nas/docker-compose.yml) in der
Docker-App der NAS unter **Projekt → Erstellen** einfügen, Passwort anpassen, bereitstellen.
Update: Image neu herunterladen (`docker compose pull && docker compose up -d`).

Alternativ baut [`nas/docker-compose.git.yml`](nas/docker-compose.git.yml) die App direkt
aus dem Repository, ganz ohne Registry.

### Ohne Compose

```bash
docker build -t familienplaner .
docker run -d --name familienplaner -p 3000:3000 \
  -e APP_PASSWORD=geheim -e TZ=Europe/Berlin \
  -v familienplaner-data:/data familienplaner
```

### Einstellungen (Umgebungsvariablen)

| Variable       | Standard        | Bedeutung                                                     |
|----------------|-----------------|---------------------------------------------------------------|
| `APP_PASSWORD` | *(leer)*        | Familien-Passwort. Leer = keine Anmeldung nötig.              |
| `PORT`         | `3000`          | Port auf dem Host (in `docker-compose.yml`).                  |
| `TZ`           | `Europe/Berlin` | Zeitzone des Containers.                                      |
| `MAX_UPLOAD_MB`| `25`            | Maximale Größe pro Dokument in MB.                            |
| `DATA_DIR`     | `/data`         | Ablageort von Datenbank und Dokumenten im Container.          |

### Daten & Backup

Alle Daten liegen im Volume `familienplaner-data`: die Datenbank in
`/data/familienplaner.db`, hochgeladene Dokumente in `/data/uploads/`. Backup zum Beispiel so:

```bash
docker run --rm -v familienplaner-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/familienplaner-backup.tgz -C /data .
```

### Als App auf iPhone/iPad (und Android)

Der Familienplaner lässt sich wie eine normale App mit eigenem Icon auf den
Home-Bildschirm legen – ohne App Store:

1. Die Adresse der App (z. B. `http://192.168.1.20:3000`) in **Safari** öffnen.
2. Unten auf **Teilen** (Quadrat mit Pfeil nach oben) tippen.
3. **„Zum Home-Bildschirm“** wählen, Namen bestätigen, **Hinzufügen**.

Die App startet dann im Vollbild ohne Browserleiste. Wichtig: Ist ein `APP_PASSWORD`
gesetzt, muss man sich in der Home-Bildschirm-App einmal neu anmelden – iOS trennt
deren Speicher von Safari. Unter Android geht es in Chrome über **⋮ → „Zum Startbildschirm
hinzufügen“** bzw. **„App installieren“**.

Tipp: Damit die Adresse sich nicht ändert, im Router eine feste IP für den Server
vergeben. Für Zugriff von unterwegs siehe nächster Abschnitt.

### Zugriff von unterwegs

Die App ist für das Heimnetz gedacht. Für den Zugriff von außen bitte einen Reverse-Proxy
mit HTTPS davorschalten (z. B. Caddy, Traefik, Nginx Proxy Manager) oder ein VPN
wie WireGuard/Tailscale nutzen – und unbedingt `APP_PASSWORD` setzen.

## Entwicklung ohne Docker

Benötigt Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`, keine npm-Pakete nötig).

```bash
npm start      # http://localhost:3000
npm test       # API- und Wiederholungs-Tests
```

## Aufbau

```
familienplaner/
├── server.js            # HTTP-Server, REST-API, SQLite, Live-Updates
├── public/              # Web-Oberfläche (HTML, CSS, JavaScript ohne Framework)
├── test/api.test.js     # Tests
├── Dockerfile
└── docker-compose.yml
```
