## 1 ## 00.15

- Hallo in die Runde. Ich möchte euch heute gerne das Tool Terrablox vorstellen
- mit dem man Cloud Migrationen vielleicht ein bisschen einfacher machen kann

## 2 ## 00.35

- Aber starten möchte ich mit einer These die ich einfach mal so in den Raum stelle möchte
- Und zwar glaube ich nicht, dass der Einsatz von AI in ein paar Jahren noch ein großer Wettbewerbsvorteil sein wird

- Dafür kann man sich ja mal die Vergangenheit anschauen dann nimmt eig jede Basistechnologie
- Zuerst Vorsprung dann Voraussetzung
- Früher hatte man auch DURCH Strom, IT oder Internet einen gewissen Vorsprung für eine kurze Zeit, aber heute ist das alles natürlich Standard

- Ich glaube so wird es auch mit AI sein
- Aktuell kann man vielleicht noch einen Vorteil aus AI ziehen
- Aber ich glaube das wird nicht mehr so sehr lange anhalten


## 3 ## 00.30

- Jeder wird die besten LLMs und die besten Harnesse haben
- Wobei aktuell würde ich noch sagen dass in einem Harness noch recht viel Handarbeit steckt
- Aber auch die werden auch immer mehr Open Source
- Und Harnesse werden direkt in die Frameworks eingebaut
- Dann wirklich jeder irgendwann Zugriff auf besten Harnesse hat

- Und ich glaube in einer Agentic World sind Daten der einzige Unterschied den es noch geben wird
- Und mit dem man sich noch vom Wettbewerb abgeben kann

## 4 ## 01.00

- Deswegen finde ich den folgenden Satz so wichtig
- Die Daten von gestern sind der Wettbewerbdsvorteil von heute

- Und ich weiß nicht wie es bei euch in der praxis so ist
- Aber ich habe jetzt für mich nicht das Gefühl dass wir aktuell irgendwelche Daten bei MHP sammeln
- Einfach mal am Beispiel von Cloud Migrationen
- Da steckt eigentlich das ganze Wissen in unseren Köpfen
- Und am Ende hat man dann einfach nur ein fertiges Repository
- Einen fertigen AWS Account und das wars
- Aber was uns fehlt sind ja die ganzen Zwischenschritte
- Und das sind glaube ich die Daten die uns fehlen für einen echten Wettbewerbsvorteil in einer Agentic World

## 5 ## 01.00

- Aktuell ist es ja so dass man am Ende einer Migration einfach nur Code in einem Repo rumliegen
- Vielleicht noch ein bisschen Dokumentation aber das wars dann auch meist schon
- Und daraus kann ein Agent jetzt nicht wirklich effektiv lernen für neue, kommende Migrationen in der Zukunft
- Deswegen habe ich mir gedacht es wäre doch richtig cool wenn man irgendwie ne Art strukturierte Transformationen bekommen würde für jede Migration
- Mit festen Schritten, definiertem Ist und Soll Zustand
- Und alle Schritte dazwischen sind nachvollziehbar und zentral abgespeichert
- Und deswegen habe ich angefangen das Tool Terrablox zu bauen

## 6 ## 01.00

- Terrablox ist erstmal auch nur ein Agent Harness für Cloud Migrationen
- Es gibt hier links einen Ist Zustand, das ist der Input
- Das kann im besten Fall ein Applicationsrepo in dem eine Application lebt und die man zb von Onprem in die Cloud migrieren will
- Oder man hat nur Dokumentationen oder irgendeine Beschreibung von einem PO
- Die Migration führt dann ein Agent Harness aus
- Dort sind Best Practises definiert, es gibt ein festes Toolset und Guardrails
- Und am Ende hat man dann eben das fertige Repository und eine komplett deployte Infrastruktur in einem AWS Account

## 7 ## 02.00

- Soweit so gut, jetzt zum interessaten Teil
- So die Hauptidee hinter Terrablox ist jetzt, dass das LLM eben keinen eigenen neuen Code generiert
- Sondern es führt nur Änderungsoperationen auf einem Graphen Modell aus
- Die Idee ist grundsätzlich eigentlich nicht so neu und kommt aus dem Model Driven Development
- Bisher arbeiten die meisten vermutlich so, dass ihr Prompts schreibt
- Ihr habt vielleicht noch MCPs angebunden
- Und dann generiert das LLM komplett neuen Code auf Basis von eurem Kontext
- Und Terrablox arbeitet hier eben ein bisschen anders und ist komplett Modellgetrieben
- Dh es wird kein neuer Code generiert sondern es werden nur bestimmte Operationen auf einem Graph ausgeführt

- Und als Basis dafür werden fertige Terraform Module verwendet
- Also pro AWS Service gibt es ein Terraform Modul welches schon die Best Practises implementiert hat
- Dh jedes Terraform Modul ist ein Knoten in dem Graph
- Und dann gibt es noch Kanten die die Module verbinden
- Also jeder Modul Output der in einen Input geht ist eine Kante
- Und dann kann man eben auf diesem Graph arbeiten

## 8 ##

- Aktuell greift Terrablox auf 50 Terraform Module zu
- Das sind Open Source Module die schon sehr gut implememntiert sind
- Aktuell bin ich noch dabei für das Porsche Umfeld die CbbaC in den Katalog aufzunehmen
- Und es gibt auch MHP intern ein Team die auch gerade solche Module aufbauen
- Mit den MHP best practises, die möchte ich auch noch mit aufnehmen sobald die fertig sind

## 9 ## 02.00

- Das klingt jetzt vielleicht noch sehr abstrakt
- Deswegen habe ich ein Beispiel mitgebraucht wie das ganze aussehen kann
- Links sehen wir gleich wie der Agent Operationen ausführt
- In der Mitte wird dann der Graph aufgebaut
- Und auf Basis des Graphs wird dann deterministisch Terraform Code abgeleitet

- Wir sehen hier wurde das VPC Modul ausgewählt ....

## 10 ##

- Um jetzt nochmal auf die Daten zurückzukommen
- Jeder Agent Turn in Terrablox legt als Ergbnis eine Transformation als JSON Object in die Datenbank
- Es gibt hier den Ist und Soll Stand als Graphenrepräsentation
- Dann wird festgehalten welche Operationen in welcher Reihenfolge ausgeführt wurden
- Es werden Entscheidungen und Begründungen des Agents festgehalten
- Quellen stehen mit dabei
- Und so eine Transformationen kann/sollte dann noch von einem Developer bewertet werden
- Man kann Feedback geben
- Dadurch lernt der Agent wie er Tranformationen in Zukunft besser machen kann

## 11 ##

- Und dadurch kann man jetzt mit jeder Cloud Migrationen strukturierte Daten sammeln
- Und je mehr Migrationen man macht, desto mehr Daten hat man natürlich, desto besser werden potenziell Migrationen in Zukunft
- Der große Ausblick wäre natürlich dass man einen großen geteilten Datensatz bei MHP hat auf den jeder Zugreifen kann
- Und so jede Cloud Migrationen noch ein bisschen besser wird

## 12 ##

- Ich möchte euch gerne einladen das Tool einfach mal auszuprobieren
- Weil aktuell verlieren wir Daten mit jeder Migration die war machen
- Aktuell ist es noch ein MVP und kann lokal auf eurem Rechner ausgeführt werden
- Das ganze ist Open Source, einfach klonen und ausführen
- Und falls ihr Bock habt könnt ihr natürlich auch gerne mit arbeiten