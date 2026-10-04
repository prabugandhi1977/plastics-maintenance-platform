// German field app help: same topic ids and step counts as TOPICS in help.js. Buttons are quoted as the German
// interface shows them – translated where the app translates them, otherwise in English as on screen.
export const TOPICS_DE={
  list:{title:'Ihre Auftragsliste',steps:[
    '<b>Zugewiesene Aufträge</b> listet die Ihnen zugewiesenen Störmeldungen, die neuesten zuerst. Zum Öffnen antippen.',
    'Der Kopf zeigt <b>Online</b> oder <b>Offline</b> und wie viele Änderungen auf diesem Telefon warten (<b>queued</b>).',
    '<b>Jetzt synchronisieren</b> sendet wartende Änderungen und holt Ihre aktuellen Aufträge.',
    '<b>Abmelden</b> geht nur, wenn nichts mehr wartet, damit keine Arbeit verloren geht. Vorher synchronisieren.']},
  scan:{title:'Eine Maschine scannen',steps:[
    'Unter <b>Scan a machine</b> das QR-Etikett der Maschine mit der Kamera scannen, ihren RFID-Tag lesen oder den Code eintippen.',
    'Haben Sie an dieser Maschine offene Arbeit, öffnet sie sich sofort.',
    'Sonst öffnet sich – wenn Ihre Rolle Störungen melden darf – das Formular zum <b>Melden einer Störung</b> für diese Maschine: Kurzbeschreibung, Symptome, Maschinenzustand, Priorität und Auswirkung.',
    'Offline vergleicht die App den Code mit Ihren gespeicherten Aufträgen. Eine offline gemeldete Störung wartet, und die Maschine wird beim Synchronisieren erkannt.'],
    tips:['„Unknown code“ bedeutet, dass das Etikett oder der Tag keiner Maschine zugeordnet ist – den Maschinendatensatz im Büro prüfen.','„This machine has no work for you“ bedeutet, dass sie zu einem Kunden oder Auftrag gehört, dem Sie nicht zugewiesen sind.']},
  ticket:{title:'Eine Störmeldung bearbeiten',steps:[
    '<b>Status ändern</b>: zugewiesen → angenommen (oder abgelehnt / eskaliert mit Notiz) → in Arbeit → abgeschlossen.',
    'Zum Abschließen Ausfallart, Grundursache, Maßnahme und Stillstand angeben. Verlangt die Scan-Regel es, das Etikett der Maschine erneut scannen, um zu belegen, dass Sie vor Ort sind.',
    '<b>Ausgeführte Arbeit erfassen</b>: was Sie getan haben, Minuten und verbaute Teile.',
    '<b>Prüfpunkt hinzufügen</b> für jeden Prüfpunkt; einen Punkt antippen, um ihn abzuhaken.',
    '<b>Ersatzteil anfordern</b>: Teilenummer, Beschreibung, Menge, Einheit und Dringlichkeit. Angebote und Freigabe erledigt das Büro.',
    '<b>Add photo</b> hängt einen Nachweis aus der Kamera an.',
    '<b>⚠ Report safety concern</b> für eine Gefahr, einen Beinaheunfall oder eine Verletzung. Die Meldung geht in das Sicherheitsprotokoll des Werks.',
    'Nach dem Abschluss das Telefon dem Kunden für die <b>Kundenabnahme</b> geben: Name und Unterschrift.'],
    tips:['Ein roter Hinweis <b>Safety issue reported</b> bedeutet, dass die Maschine vor Arbeitsbeginn gesichert werden muss.','Live-Messwerte der Maschine erscheinen unter <b>Maschinendaten</b>, wenn die Maschine angebunden ist.']},
  assistant:{title:'KI-Assistent und Reparaturanleitung',steps:[
    '<b>Ask AI assistant</b>: beschreiben, was Sie sehen; die Antwort stützt sich auf die Störmeldung, die Handbücher der Maschine und Live-Daten. Sie können ein Foto hinzufügen.',
    '<b>Repair guide</b> gibt eine Schritt-für-Schritt-Reparaturanleitung für diese Maschine. Bei kritischen Störmeldungen lässt sie sich als <b>VR guide</b> öffnen.',
    'Beides braucht eine Verbindung, und der KI-Assistent muss von Ihrem Administrator eingerichtet sein.']},
  offline:{title:'Offline arbeiten',steps:[
    'Ihre zugewiesenen Aufträge und die geöffneten Störmeldungen bleiben auf diesem Telefon, damit Sie ohne Netz arbeiten können.',
    'Jede Änderung wird sofort auf dem Telefon gespeichert („Auf dem Gerät gespeichert. Wird bei Verbindung synchronisiert.“) und an der Störmeldung angezeigt.',
    'Sobald die Verbindung zurück ist, werden wartende Änderungen automatisch der Reihe nach gesendet. Sie können auch <b>Jetzt synchronisieren</b> antippen.',
    'Eine Änderung wird nie doppelt übernommen, auch wenn sie nach einem Verbindungsabbruch erneut gesendet wird.'],
    tips:['Öffnen Sie die benötigten Störmeldungen, bevor Sie an einen Ort ohne Netz gehen, damit sie gespeichert sind.','KI-Assistent, Reparaturanleitung und Fotos anderer Aufträge brauchen eine Verbindung.']},
  vision:{title:'Vision-Alarme',steps:[
    'Haben Sie eine Vision-Zuständigkeit (EHS, Sicherheit oder QA), erscheinen Kameraalarme für Ihr Werk oben in der App.',
    'Ein kritischer Alarm wie Feuer oder ein PSA-Verstoß lässt das Telefon vibrieren und einen Ton abspielen.',
    '<b>View</b> zeigt Foto und Details, <b>Acknowledge</b> zeigt den Kollegen, dass er bearbeitet wird.'],
    tips:['Ihre Zuständigkeiten legt ein Administrator im Büro-Arbeitsbereich unter Firmen, Werke & Benutzer › Users › Vision duties fest.']},
  install:{title:'Die App auf dem Telefon installieren',steps:[
    'Diese Seite im Browser des Telefons öffnen und anmelden.',
    'Android (Chrome): Menü ⋮ › <b>App installieren</b> oder <b>Zum Startbildschirm hinzufügen</b>.',
    'iPhone (Safari): Teilen › <b>Zum Home-Bildschirm</b>.',
    'Die App über das Symbol auf dem Startbildschirm starten. Dann funktioniert sie offline wie oben beschrieben.']},
};
