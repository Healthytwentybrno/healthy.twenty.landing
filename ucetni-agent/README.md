# Účetní agent – Healthy Twenty Brno

Malá aplikace nad tvým Google Sheetem. Umí:

1. **Doklady:** vyfotíš účtenku nebo nahraješ PDF faktury. AI doklad přečte (dodavatel, částka, DPH, datum, kategorie), **spáruje ho s platbou z bankovního výpisu**, uloží ho **na Google Disk do složky účetní** (`Rok/Měsíc`) a zapíše řádek do **záložky daného měsíce** (např. `2026-11`). Hned vidíš potvrzení, co a kam vložila.
2. **Bankovní výpis:** nahraješ CSV nebo PDF. Všechny pohyby se zapíšou do měsíčních záložek a samy se spárují s doklady, které už jsou nahrané. U plateb bez dokladu ukáže **„Chybí doklad“**.
3. **Měsíční přehled:** záložka `Přehled` (a obrazovka v aplikaci) ukazuje **tržby, náklady a zisk** po měsících. V každé měsíční záložce je vpravo souhrn a rozpad nákladů podle kategorií.
4. **Permanentky:** zapíšeš klientku, typ permanentky a datum nákupu. Konec platnosti se dopočítá sám a aplikace ukazuje, **komu kdy končí platnost** (barevně: končí brzy / platná / prošlá). E-maily se zatím neposílají.

Běží to celé na serverech Googlu (Google Apps Script), zdarma a bez vlastního serveru.
Platí se jen za AI (Claude API): řádově **jednotky korun za doklad**. Přesná cena závisí na velikosti dokladu, aktuální ceník je na console.anthropic.com.

---

## Instalace (cca 15 minut, jen jednou)

### 1. API klíč pro AI
1. Jdi na **console.anthropic.com** a založ si účet.
2. V části *Billing* nabij kredit (stačí pár set korun) a nastav si měsíční limit útraty.
3. V části *API Keys* dej **Create Key** a klíč (začíná `sk-ant-`) si zkopíruj. Nikomu ho neposílej.

### 2. Vložit skript do Google Sheetu
1. Otevři svůj Google Sheet pro účetnictví.
2. Menu **Rozšíření → Apps Script**.
3. V levém panelu je soubor `Kód.gs` (`Code.gs`). Vyber v něm všechno a smaž.
4. Pro každý soubor ze složky [`apps-script/`](apps-script/) vytvoř v editoru soubor se **stejným názvem** (tlačítko **+ → Skript**, u `Index` **+ → HTML**) a vlož do něj obsah:
   - `Config.gs`, `Claude.gs`, `Sheets.gs`, `Matching.gs`, `Doklady.gs`, `Banka.gs`, `Permanentky.gs`, `Setup.gs`, `WebApp.gs`
   - `Index.html` (v editoru se jmenuje jen `Index`)
5. Soubor `appsscript.json`: v editoru vlevo **⚙️ Nastavení projektu** → zaškrtni *„Zobrazit soubor manifestu appsscript.json“*. Pak se soubor objeví v seznamu a jeho obsah nahraď tím z této složky.
6. Ulož (ikona diskety nebo Ctrl+S).

### 3. První spuštění
1. Vrať se do Sheetu a obnov stránku (F5). Nahoře se objeví menu **🤖 Účetní agent**.
2. **🤖 Účetní agent → 1) První nastavení.** Google se zeptá na oprávnění: *Pokračovat → vyber svůj účet → Rozšířené → Přejít na projekt (nebezpečné) → Povolit*. Varování je běžné, protože skript je tvůj vlastní a Google ho neověřoval.
   - Vytvoří se záložky **Přehled**, **Permanentky**, **Typy permanentek** a záložka aktuálního měsíce.
   - Na Disku se vytvoří složka **„Účetnictví – Healthy Twenty“**.
3. **🤖 Účetní agent → 2) Nastavit API klíč:** vlož klíč z kroku 1.
4. Složka pro účetní, vyber jednu z možností:
   - nech tu, kterou skript vytvořil, a **nasdílej ji účetní** (na Disku pravým tlačítkem → Sdílet → e-mail účetní, role *Čtenář* nebo *Editor*), **nebo**
   - pokud už účetní má vlastní složku a nasdílela ti ji s právem úprav: **🤖 Účetní agent → 3) Nastavit složku účetní** a vlož odkaz na ni.

### 4. Aplikace do mobilu
1. V editoru Apps Script vpravo nahoře **Nasadit → Nové nasazení**.
2. Typ (ozubené kolo): **Webová aplikace**.
   - *Spustit jako:* **Já**
   - *Kdo má přístup:* **Jen já**
3. **Nasadit** a zkopíruj **adresu webové aplikace** (končí `/exec`).
4. Otevři ji v mobilu (přihlášený ke stejnému Google účtu) a dej **Sdílet → Přidat na plochu**. Funguje pak jako aplikace.

> Když později upravíš kód: **Nasadit → Spravovat nasazení → ✏️ → Verze: Nová verze → Nasadit**. Adresa zůstane stejná.

### 5. Typy permanentek
V záložce **Typy permanentek** přepiš ukázkové řádky podle svého ceníku:

| Typ | Platnost (měsíce) | Platnost (dny navíc) | Cena (Kč) |
|---|---|---|---|
| 10 vstupů | 3 | 0 | … |
| Zkušební trénink | 0 | 14 | … |

Konec platnosti = datum nákupu + měsíce + dny. Když klientce platnost prodloužíš (nemoc, dovolená), zapiš nové datum do sloupce **„Konec ručně“**.

---

## Jak to používat

**Běžný měsíc:**
1. Během měsíce průběžně fotíš doklady v aplikaci (záložka 📄 Doklady). Ty, ke kterým ještě není platba z výpisu, se uloží jako **„Doklad bez platby“**.
2. Na začátku dalšího měsíce stáhneš z internetového bankovnictví **výpis za minulý měsíc v CSV** a nahraješ ho (🏦 Výpis). Pohyby se zapíšou a doklady se k nim samy přiřadí.
3. V 📊 Přehledu uvidíš tržby, náklady, zisk a seznam **plateb bez dokladu**. Ty dofotíš, a když doklad nahraješ, spáruje se sám.
4. Účetní má všechno ve své složce na Disku a může mít náhled i do tabulky (nasdílej jí Sheet jen pro čtení).

**Stavy v tabulce:**

| Stav | Význam |
|---|---|
| 🟢 Spárováno | platba z banky + doklad, hotovo |
| 🔴 Chybí doklad | v bance je výdaj, ale doklad ještě nemáš |
| 🟡 Doklad bez platby | doklad je nahraný, platba zatím ve výpisu není (nebo se platilo hotově) |
| 🔵 Příjem | příchozí platba (tržba) |
| ⚪ Bez dokladu (OK) | bankovní poplatky, daně, odvody, mzdy, převody (doklad se nečeká) |

**Ruční úpravy:** v Sheetu můžeš cokoli přepsat (kategorii, částku, poznámku) a souhrny se přepočítají samy. Tržby v hotovosti zapiš jako nový řádek s kladnou částkou a kategorií *Tržby*. Kategorie **„Převod (nepočítat)“** se do tržeb ani nákladů nezapočítává.

---

## Jak párování funguje

Doklad a platba patří k sobě, když:
- mají **stejnou částku** (tolerance 1 Kč) a stejný směr (výdaj/příjem),
- platba je nejvýš **10 dní před** a nejvýš **60 dní po** datu dokladu,
- při více kandidátech vyhraje shodný **variabilní symbol**, pak podobný název firmy, pak nejbližší datum.

Limity se dají změnit v souboru `Config.gs`.

---

## Na co si dát pozor
- **AI se může splést** (rozmazaná účtenka, ručně psaný paragon). Po nahrání si zkontroluj potvrzení a v tabulce případně oprav. Za účetnictví odpovídá účetní, tohle je příprava podkladů.
- **CSV je přesnější než PDF**. PDF výpis s mnoha pohyby může narazit na časový limit Googlu (6 minut).
- Stejný doklad nebo výpis nahraný dvakrát se **nezduplikuje**.
- Aplikace je přístupná **jen tobě** (tvůj Google účet). API klíč je uložený v nastavení skriptu, ne v tabulce.

## Co dál (až budeš chtít)
- automatický e-mail klientce před koncem permanentky,
- automatické stahování výpisu (Fio banka má API),
- měsíční e-mail účetní se souhrnem,
- nápady na akce, kampaně a grafiky.
