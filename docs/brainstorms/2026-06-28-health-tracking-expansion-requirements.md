---
date: 2026-06-28
topic: health-tracking-expansion
---

# Rozszerzenie trackera: peptydy, TRT, objawy, korelacje

## Summary

Rozbudowa osobistego trackera (`index.html`) z samej wagi + zastrzyków Mounjaro o: codzienny dziennik objawów z **edytowalnymi przez użytkownika** metrykami, wspólny log zastrzyków dla trzech substancji (Mounjaro / TRT / peptydy KLOW) z wizualną mapą ciała do rotacji miejsc wkłucia, sporadyczne pomiary (ciśnienie), master-dashboard z przeglądem rytmów wszystkich substancji, oraz widok korelacji nakładający dowolne dwie serie czasowe. Cel: ustawić baseline przed startem TRT i KLOW, przy wprowadzaniu danych < 30 s dziennie.

## Problem Frame

Aplikacja śledzi dziś wagę i tygodniowe zastrzyki Mounjaro. Wchodzą trzy nowe zmienne równolegle: peptydy KLOW (codziennie), TRT (2-3x/tydzień, long-term) oraz tapering stymulantów. Bez jednego miejsca na objawy, vitale i zastrzyki dane rozjeżdżają się po notatkach i nie da się z nich wyciągnąć korelacji (np. dawka KLOW vs ból łokcia, odstawianie leków vs tętno spoczynkowe). Moment jest jednorazowy: wpisanie tego do kodu **przed** startem TRT/KLOW daje czysty punkt odniesienia „przed/po". Codzienne wpisywanie musi być trywialne, inaczej nie będzie robione.

## Key Decisions

- **Zostajemy w obecnej architekturze — żadnego backendu.** Wklejona wcześniej rekomendacja (Supabase / Postgres / Vercel KV / Chart.js / React) jest sprzeczna z aplikacją: to jeden plik `index.html`, dane w `localStorage` (klucz `mounjaro.v1`), a CSP w `vercel.json` blokuje wszystkie zewnętrzne origins (gwarancja prywatności — nic nie wychodzi z urządzenia). Wszystkie nowe funkcje mieszczą się w istniejących modułach (DOMAIN/STORE/CHART/UI) bez nowych plików ani bibliotek.
- **Objawy są definiowane przez użytkownika, nie hardcoded.** Sercem dziennika jest edytowalny z UI rejestr metryk (dodaj/zmień nazwę/wyłącz), a nie sztywna lista pól w kodzie. To bezpośrednio odrzuca podejście wklejonego spec'a (`pain_elbow`, `inflammation_eyes` itd. wpisane na stałe).
- **Wszystko jest serią czasową.** Każda metryka, dawka zastrzyku, pomiar ciśnienia, a także istniejąca waga i dawka Mounjaro, dają się odczytać jako `[{date, value}]`. To jeden wspólny abstrakcyjny kształt, na którym stoją korelacje.
- **Jedna zakładka „Zastrzyki" z przełącznikiem substancji, jeden silnik.** Mounjaro / TRT / Peptydy to segmenty jednej zakładki na wspólnym kodzie iniekcji, każdy z polami i widżetem rytmu pod siebie. Mounjaro przenosi się tu z obecnej zakładki Jab i zachowuje pierścień odliczania.
- **Mapa ciała jest wspólna i ponad-substancyjna.** Jeden komponent inline-SVG pokazuje wszystkie ostatnie wkłucia (kolor wg substancji), niezależnie od tego, w którym segmencie jesteś. Cel to „nie wbijaj się dwa razy w to samo miejsce", a nie precyzja medyczna.
- **Master-dashboard jako ekran startowy.** Rzut oka pokazuje rytm wszystkich substancji naraz; drążenie w segmenty/dziennik tylko przy wprowadzaniu lub szczegółach.

## Requirements

### Model danych i migracja

- R1. Stan aplikacji zyskuje nowe struktury w `STORE.defaults()`: edytowalny rejestr metryk, log zdarzeń (objawy/zastrzyki/pomiary) i konfigurację substancji. Wszystkie dodane jako nowe pola, żeby `merge()` doczytał stare backupy bez utraty danych.
- R2. Każda nowa struktura danych musi przeżyć import starego backupu sprzed zmiany (brakujące pola = wartości domyślne, istniejące `weightLog`/`jab.history` nietknięte).
- R3. Istniejące dane (waga, historia Mounjaro) pozostają w swoich strukturach; nowe funkcje czytają je jako serie czasowe, nie migrują ich do nowego modelu.

### Rejestr metryk (objawy definiowane przez użytkownika)

- R4. Użytkownik może z poziomu UI dodać metrykę, podając nazwę, typ (suwak 0-10, suwak 0-5, liczba, tak/nie) i flagę „codzienna / doraźna".
- R5. Użytkownik może zmienić nazwę metryki oraz ją wyłączyć/zarchiwizować bez kasowania historycznych wartości (zachowanie danych do korelacji).
- R6. Metryki oznaczone jako „codzienne" pojawiają się automatycznie w ekranie dziennika; „doraźne" są dostępne, ale nie wymuszane codziennie.
- R7. Każda metryka jest dostępna jako wybieralna seria w widoku korelacji.

### Dziennik dzienny

- R8. Ekran dziennika pokazuje na dziś tylko metryki „codzienne" jako suwaki/pola, jeden szybki przepływ zapisu (cel < 30 s).
- R9. Sporadyczne pomiary (ciśnienie skurczowe/rozkurczowe; waga przez istniejący mechanizm) są dopisywane przyciskiem akcji, nie wymuszane codziennie.
- R10. Wpis dzienny jest powiązany z datą; ponowne wejście tego samego dnia pozwala podejrzeć/poprawić dzisiejsze wartości (zachowana edycja, spójna z istniejącym `weightLog`).

### Zastrzyki — segmenty i rytm

- R11. Jedna zakładka „Zastrzyki" z przełącznikiem segmentów: Mounjaro, TRT, Peptydy. Wspólny silnik logowania, pola specyficzne per substancja.
- R12. Mounjaro: zachowuje pierścień odliczania do następnego tygodniowego strzału (obecne zachowanie, przeniesione z zakładki Jab).
- R13. TRT: long-term (bez cyklu); pasek postępu odlicza od ostatniego do następnego wstrzyknięcia wg ustawianego interwału (~2-3 dni).
- R14. Peptydy (KLOW): bez odliczania do strzału (codzienne); pasek postępu **cyklu** — użytkownik definiuje długość cyklu, pasek pokazuje dzień X / długość i ile do końca.
- R15. Zalogowanie zastrzyku zapisuje substancję, dawkę (jednostki/mg wg substancji), datę i wybrane miejsce wkłucia; dawka jest dostępna jako seria w korelacjach.

### Mapa ciała (rotacja miejsc)

- R16. Wspólny komponent inline-SVG (sylwetka, brzuch-centryczny) z 10 strefami na teraz: 4 kwadranty brzucha, 4 love handles (2 lewy bok, 2 prawy bok), 2 wewnętrzne strony uda (L, P). Wszystko podskórnie.
- R17. Lista stref jest danymi, nie sztywnym rysunkiem na stałe — dołożenie kolejnych miejsc (np. tył ramion) to dopisanie punktów bez przebudowy modelu.
- R18. Przy logowaniu zastrzyku otwiera się mapa pokazująca ostatnie wkłucia **wszystkich** substancji, pokolorowane wg substancji; starsze wkłucia blakną z czasem.
- R19. Mapa podświetla sugerowane następne miejsce (najdawniej używana strefa, licząc wkłucia wszystkich substancji łącznie).
- R20. Kliknięcie strefy na mapie zapisuje miejsce dla bieżącego zastrzyku.

### Dashboard

- R21. Ekran startowy (dashboard) pokazuje na jednym widoku trzy widżety rytmu: Mounjaro (pierścień, „następny za X dni"), TRT (pasek, „następny za X dni"), Peptydy (pasek cyklu, „dzień X / długość").
- R22. Dashboard pokazuje status „Dziś" (czy zalogowano dziś objawy i peptyd), ostatnie wartości (ciśnienie, waga + Δ), mini-mapę ostatnich wkłuć oraz szybkie akcje (+ zastrzyk, + objawy, + ciśnienie, + waga).

### Korelacje

- R23. Widok korelacji pozwala wybrać dwie dowolne serie (metryka, dawka substancji, ciśnienie, waga, dawka Mounjaro) i nakłada je na wspólnej osi czasu z dwiema osiami Y.
- R24. Wykres korelacji jest renderowany tą samą techniką inline-SVG co istniejący `CHART.render()` — zero zewnętrznych bibliotek (zgodność z CSP).

### Wydanie

- R25. Po wdrożeniu bump `CACHE` w `sw.js` (obecnie `mj-v26`), żeby zainstalowane klienty pobrały nową wersję.
- R26. Dla każdego nowego stringu UI dodać oba języki (pl/en) w słowniku `I18N`, zgodnie z obecną konwencją `data-i`.

## Key Flows

- F1. Wieczorne logowanie objawów
  - **Trigger:** Wejście na dashboard / dziennik wieczorem.
  - **Steps:** Dashboard pokazuje, że dziś brak wpisu objawów → wejście w Dziennik → suwaki metryk „codziennych" ustawione → zapis. Opcjonalnie „+ ciśnienie" jeśli mierzone.
  - **Outcome:** Wpis dnia zapisany w < 30 s; dashboard pokazuje status „Dziś ✓".
  - **Covered by:** R6, R8, R9, R10, R22.

- F2. Zalogowanie zastrzyku z wyborem miejsca
  - **Trigger:** Wykonanie zastrzyku (dowolna substancja).
  - **Steps:** Zakładka Zastrzyki → segment substancji (lub szybka akcja z dashboardu) → wpis dawki → otwiera się wspólna mapa ciała z ostatnimi wkłuciami (kolory) i podpowiedzią → klik w wolną strefę → zapis.
  - **Outcome:** Zastrzyk zapisany z miejscem; rytm/pasek substancji zresetowany/odświeżony; mapa zaktualizowana dla wszystkich segmentów.
  - **Covered by:** R11, R12, R13, R14, R15, R18, R19, R20.

- F3. Dodanie nowej śledzonej metryki
  - **Trigger:** Pojawia się nowy objaw, który użytkownik chce śledzić.
  - **Steps:** Ekran metryk → „dodaj" → nazwa + typ + „codzienna/doraźna" → zapis.
  - **Outcome:** Metryka pojawia się w dzienniku (jeśli codzienna) i jest dostępna w korelacjach, bez zmian w kodzie.
  - **Covered by:** R4, R5, R6, R7.

- F4. Sprawdzenie korelacji
  - **Trigger:** Chęć zobaczenia zależności między dwiema zmiennymi.
  - **Steps:** Widok korelacji → wybór serii A i serii B → nałożony wykres dwóch osi Y.
  - **Outcome:** Wizualna korelacja (np. dawka KLOW vs ból łokcia; tapering leków vs tętno/ciśnienie).
  - **Covered by:** R7, R23, R24.

## Scope Boundaries

Odłożone na później (nie v1, ale model to przewiduje):
- Strefy ramion na mapie ciała (R17 zostawia furtkę — dopisanie punktów).
- Ponumerowane pod-punkty w obrębie strefy (precyzja medyczna co do punktu) — na teraz wystarczy 10 stref + blaknięcie.
- Przypomnienia/powiadomienia push o zastrzyku/cyklu.
- Iniekcje domięśniowe jako osobny tryb mapy (na teraz wszystko podskórne, jedna mapa).

Poza tożsamością tej aplikacji:
- Backend / konto / sync przez chmurę poza istniejącym mechanizmem „linked file" i eksportem JSON.
- Wielu użytkowników — aplikacja jest świadomie tylko dla właściciela.

## Outstanding Questions

Do rozstrzygnięcia przy planowaniu (HOW, nie WHAT):
- Dokładny kształt pól w `defaults()` dla rejestru metryk, logu zdarzeń i konfiguracji substancji (interwał TRT, długość cyklu peptydów, kolory substancji).
- Czy istniejąca zakładka Jab zostaje przeniesiona/usunięta na rzecz segmentu Mounjaro w „Zastrzyki", czy chwilowo współistnieją.
- Czy ciśnienie modelować jako jedną metrykę dwuwartościową, czy dwie serie (skurczowe/rozkurczowe) — wpływ na korelacje.
- Układ nawigacji przy nowych zakładkach (Dashboard, Zastrzyki, Dziennik, Korelacje) obok istniejących kalkulatorów — możliwe grupowanie/overflow na wąskich ekranach.

## Sources

- `index.html` — `STORE.defaults()` (~L826), `merge()` (~L856): mechanizm migracji przez głębokie scalanie.
- `index.html` — `CHART.render(log)` (~L1128): inline-SVG seria czasowa kolorowana wg dawki; baza pod dual-axis korelacje.
- `index.html` — `routes` (~L2154) i `UI`: hash-router i wzorzec widoków do dodania nowych zakładek.
- `sw.js` — `CACHE = "mj-v26"` (~L3): wersja cache do bumpa przy wydaniu.
- `vercel.json` — CSP zakazujący zewnętrznych origins: powód, dla którego cały kod i wizualizacje zostają inline/same-origin.
