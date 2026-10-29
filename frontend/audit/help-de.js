// Deutsche Hilfetexte der Energie-Audit-App (gleiche Themen-IDs wie help.js). Statischer, vertrauenswürdiger Text.
export const TOPICS_DE={
  __title:'Hilfe',
  start:{title:'Was die App macht',steps:[
    'Sie misst den <b>spezifischen Energieverbrauch (SEC, kWh pro kg)</b> einer Spritzgießmaschine während eines Testlaufs, zeigt, wo im Zyklus die Energie verbraucht wird, und schätzt, was ein besserer Hydraulikantrieb (Verstellpumpe oder Servo-Pumpe) einsparen könnte.',
    'Anmelden mit dem MouldCare-Konto. Kundenadmins, Werksleiter, Instandhaltung und Plattform-Admins führen Audits für ihre Firma durch; Disponenten können sie lesen.',
    'Installieren: in Chrome <b>Zum Startbildschirm hinzufügen</b>. Die App braucht eine Verbindung; nur Bluetooth-Messwerte werden offline zwischengespeichert.']},
  new:{title:'Ein Audit anlegen',steps:[
    '<b>Neues Audit</b> antippen. Maschine, Produkt oder Werkzeug (Teilegewicht und Soll-Zykluszeit werden genutzt) und Werkstoff wählen (neuen eintippen oder die Liste unter <b>Einstellungen</b> bearbeiten).',
    'Das <b>Messgerät</b> wählen. Das Feld darunter sagt vor dem Start klar, was es kann, z. B. <i>10 Werte pro Sekunde: SEC ja, Zyklus-Karte ja</i> oder <i>meldet alle 10 Minuten: SEC ja, Zyklus-Karte nein</i>.',
    'Typenschilddaten eintragen, wenn bekannt. Der <b>Pumpentyp ist optional</b>: Bleibt er unbekannt, leitet die App den Antrieb aus dem gemessenen Verlauf ab und zeigt, wie sicher sie ist.',
    '<b>Testlauf jetzt starten</b> oder einen <b>vergangenen Zeitraum</b> wählen, um gespeicherte Daten auszuwerten. Für die Masse die Produktionszähler nutzen oder die gezählten Gutteile (kg oder Stück) eintragen.']},
  meter:{title:'Messgeräte und Datenübertragung',steps:[
    '<b>Messgeräte › Messgerät registrieren</b>. Arten: <b>Zangen-Analysator</b> (Spannung und Strom: Leistung wird gemessen, meist 10 Werte pro Sekunde), <b>LoRaWAN-Stromzange</b> (nur Strom: Leistung wird <b>geschätzt</b>, meldet alle paar Minuten) und <b>allgemein</b>.',
    '<b>WLAN (HTTP):</b> Das Gerät oder ein kleines Gateway sendet JSON an die auf der Geräteseite angezeigte Adresse, mit einem <b>Integrationsschlüssel</b> im Header <code>X-Integration-Key</code>. Ein Kundenadmin erstellt den Schlüssel auf der Geräteseite; er wird nur einmal angezeigt.',
    '<b>MQTT:</b> Die Plattform betreibt keinen MQTT-Client. Eine Brücke (z. B. Node-RED oder ein Mosquitto-Skript) zwischen Broker und der <i>Payload</i>-Adresse sendet jede Nachricht dorthin.',
    '<b>Feldzuordnung:</b> Jedes Gerät benennt seine Felder anders, deshalb legen Sie fest, wo jeder Wert steht, eine Zeile pro Wert, z. B. <code>kw=pwr.total *0.001</code>. Mit <b>Zuordnung testen</b> prüfen Sie sie an einer echten Nachricht. Über Hersteller wird nichts angenommen.',
    '<b>Bluetooth (experimentell):</b> In Chrome auf Android kann das Telefon eine konfigurierte GATT-Charakteristik lesen und die Messwerte weiterleiten, offline mit Zwischenspeicher. Service, Charakteristik und Byte-Aufbau tragen Sie selbst ein. Mit keinem bestimmten Gerät getestet.',
    'Die Uhr des Geräts kann abweichen. Die App nutzt die Zeitstempel des Geräts, wenn sie plausibel sind, speichert die Empfangszeit und zeigt den Zeitversatz auf der Geräteseite.']},
  run:{title:'Den Test durchführen',steps:[
    '<b>Testlauf starten</b> antippen, solange die Maschine normal produziert, und nach mindestens 20 bis 30 Zyklen <b>Stopp</b>. Der Bildschirm zeigt, wie viele Werte in der letzten Minute ankamen.',
    'Länger ist besser: Bei 10 Werten pro Sekunde liefern 15 bis 30 Minuten schon Dutzende Zyklen.',
    'Fotos von Typenschild und Messgerät unter <b>Einrichtung</b> hinzufügen.']},
  results:{title:'Ergebnisse lesen',steps:[
    '<b>SEC</b>: Energie des Tests geteilt durch Gutprodukt. Er wird mit einem orientierenden Bereich für den Antriebstyp verglichen; diese Bereiche sind Platzhalter und durch eigene Werte zu ersetzen. Was als <b>GESCHÄTZT</b> markiert ist, stammt nur aus dem Strom und kann deutlich abweichen.',
    '<b>Zyklen</b>: Die App findet die Zyklen im Leistungsverlauf (oder über das Zyklussignal der Maschine, wenn das Gerät eines sendet), zeigt die erkannte Zykluszeit gegen die Soll-Zeit und mittelt alle Zyklen zu einem Profil mit Band von Minimum bis Maximum.',
    'Die <b>Phasenvorlage</b> vom Maschinenbildschirm eintragen (Namen und Sekunden, z. B. Werkzeug schließen 2,5, Zuhaltung 1,0 …). Die Energie je Phase ist dann die Fläche unter der Kurve. Laufen Phasen am Bildschirm parallel, als eine eintragen. Mit ⚠ markierte Phasen halten die Leistung hoch, obwohl wenig Arbeit geleistet wird.',
    '<b>Antrieb</b>: die abgeleitete Klasse mit Sicherheit und Belegen. Überschreiben, wenn Sie es besser wissen. Die <b>Ineffizienz-Kennzahl</b> ist der Anteil der Zyklusenergie über Standby in Phasen mit wenig Arbeit; sie hängt nicht von der Bezeichnung ab.']},
  upgrade:{title:'Der Umrüstfall',steps:[
    'Die Einsparung entsteht aus Einsparfaktoren je Phase für den Zielantrieb (niedrig, typisch, hoch). Es sind <b>Annahmen, mit dem Lieferanten zu prüfen</b>, sie stehen neben dem Ergebnis; zu sehen unter <b>Einsparfaktoren anzeigen</b>.',
    'Jährliche Betriebsstunden, Umrüstkosten und, falls bekannt, eine Grundlast (z. B. Heizbänder), die eine neue Pumpe nicht spart, eintragen. Ergebnis: kWh und Geld pro Jahr, CO₂, einfache Amortisation und Nettoersparnis über die Jahre. Auswirkungen auf Leistungspreise sind nicht enthalten.',
    'Ist das Profil bereits servoähnlich oder vollelektrisch, gibt es keinen Umrüstfall; die App listet, was bleibt (Standby, lange Kühlzeit, Leistungsfaktor, langsamer Zyklus).',
    'Die <b>Belastbarkeit</b> sagt, wie weit den Zahlen zu trauen ist: Auflösung der Zyklus-Karte, Testdauer, Zyklenzahl, geschätzte oder gemessene Leistung.']},
  report:{title:'Der Bericht',steps:['Audit öffnen › <b>Bericht</b> und Englisch oder Deutsch wählen. Der Bericht öffnet sich als Seite zum Drucken oder Speichern als PDF. Er enthält Methode, Datenqualität, SEC gegen den Richtwert, Zyklusdiagramm, Phasentabelle, Vorschlag mit Annahmen und Amortisation sowie die Einschränkungen.']},
  data:{title:'Rohdaten und Datenschutz',steps:[
    'Hochfrequente Rohwerte werden nur für das Audit-Fenster aufbewahrt, 90 Tage nach Abschluss. Alle übrigen Rohwerte werden nach 24 Stunden zu Minutenwerten verdichtet.',
    'Unter <b>Einrichtung › Rohdaten</b> können Sie die Werte als CSV exportieren oder löschen; das gespeicherte Ergebnis bleibt.']}
};
