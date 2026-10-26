# 🎮 Counter-Strike 2 - Chat Translator & HUD Overlay

[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011%20(x64)-blue.svg)](#)
[![CS2 Compatible](https://img.shields.io/badge/Counter--Strike%202-Compatible-orange.svg)](#)
[![Translation](https://img.shields.io/badge/Engine-100%25%20Free%20Universal%20Smart%20AI-green.svg)](#)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

Valós idejű, kétirányú Counter-Strike 2 chat fordító és HUD overlay Windowsra. Olvassa a CS2 `console.log` naplófájlját, másodperc-töredék alatt lefordítja a játékosok üzeneteit (orosz, angol, német, török, stb. $\rightarrow$ magyar), és lehetővé teszi, hogy te is azonnal lefordított válaszokat küldj a játékba (`say` / `say_team`) a beépített gombnyomó vezérlés segítségével.

---

## ✨ Főbb funkciók

- **🚀 100% Ingyenes, kulcs nélküli Okos Fordítómotor (`smart`)**:
  - Nulla regisztráció, nulla API kulcs – a letöltés után bárkinél (barátoknál is) azonnal működik.
  - 4-lépcsős biztonsági hálózat: Közvetlen Google GTX $\rightarrow$ Google Clients5 $\rightarrow$ `google-translate-api-x` $\rightarrow$ MyMemory fallback.
  - **Beépített CS2 szleng- és callout szótár**: Kifejezetten a CIS/orosz játékszlengre optimalizálva (pl. *„дроп авик плз, один в коврах лоу хп”* $\rightarrow$ *„kérem dobja le az AWP-t, egyet a Palace-ban, alacsony HP”*).
  - 500-elemű LRU memória gyorsítótár a villámgyors (<50 ms) ismételt fordításokhoz.
- **💬 Kétirányú Chat & Automatikus Beküldés a Játékba**:
  - **Bejövő fordítás**: A külföldi játékosok üzenetei automatikusan magyarul jelennek meg az ablakban.
  - **Kimenő küldés**: Az alkalmazás alján található beviteli sávba beírsz egy magyar mondatot, kiválasztod a célnyelvet (pl. orosz vagy angol) és a csatornát (Mindenki / Csapat), majd az Enter lenyomásakor a program lefordítja és az `o` bind segítségével azonnal beírja a CS2 chatbe.
- **📐 HUD Mód (`H` gyorsgomb)**:
  - Egyetlen gombnyomással eltünteti a fejlécet és a küldősávot, minimalista, lebegő meccs-overlayt varázsolva a képernyő sarkába.
  - Egér ráhúzásakor az eszközök automatikusan újra előbukkannak.
- **📱 Telefonos Távirányító (QR kódos párosítás)**:
  - Nem akarsz alt-tabolni? Kattints a fejlécben a **📱 Telefon** gombra, olvasd be a QR-kódot a telefonoddal, és meccs közben a telefonod képernyőjéről is küldhetsz lefordított üzeneteket a játékba!
- **⚡ 100% Hordozható (Portable)**:
  - Semmit nem kell telepíteni: a csomag tartalmazza a futtatókörnyezetet és a lefordított natív x64 asztali alkalmazást.

---

## 🚀 Első lépések és Használat

### 1. CS2 Indítási opció beállítása (Csak egyszer szükséges!)
A játéknak engedélyeznie kell a belső konzolnaplózást, hogy a fordító olvasni tudja a chatet:

1. Nyisd meg a **Steam**-et.
2. Kattints jobb gombbal a **Counter-Strike 2**-re $\rightarrow$ **Tulajdonságok... (Properties)**.
3. Az **Általános (General)** fülön az **Indítási beállítások (Launch Options)** mezőbe írd be:
   ```text
   -condebug
   ```
4. Indítsd el egyszer a játékot, hogy létrejöjjön a `console.log`.

### 2. A Program Indítása
- Töltsd le a legfrissebb kiadást a [Releases](../../releases) fülről.
- Csomagold ki bárhová, és indítsd el a **`CS2ChatTranslator.exe`** vagy az **`Inditas.bat`** fájlt!
- Ha az Asztalra szeretnél parancsikont tenni, kattints a **`Telepites-Asztalra.bat`**-ra.

---

## ⌨️ In-Game Parancsok (A CS2 chatből közvetlenül is használható)

Ha nem a grafikus felületen írsz, a CS2 normál chatjébe írt parancsokkal is vezérelheted a fordítót:

| Parancs | Leírás | Példa |
| :--- | :--- | :--- |
| `tm_<nyelv> <szöveg>` | Lefordítja a szöveget az adott nyelvre és beírja a chatbe. | `tm_ru dobj egy fegyvert` |
| `_tl [nyelv]` | Lefordítja az előző játékos üzenetét a megadott nyelvre (alapértelmezett: `en`). | `_tl hu` |
| `code_<nyelv>` | Segítség a nyelvkódokhoz. | `code_russian` $\rightarrow$ *„For Russian use tm_ru”* |

---

## 🛠️ Forráskód és Fejlesztői Környezet

Ha saját magad szeretnéd módosítani vagy újrafordítani a projektet:

### Előfeltételek:
- Windows 10 vagy Windows 11 (x64)
- [.NET 8.0 / .NET 10.0 SDK](https://dotnet.microsoft.com/download)
- [Node.js 18+](https://nodejs.org/)

### Telepítés és Fordítás:

1. Klónozd a tárolót:
   ```bash
   git clone https://github.com/FELHASZNALONEV/cs2-chat-translator.git
   cd cs2-chat-translator
   ```

2. Telepítsd a Node.js függőségeket:
   ```bash
   npm install
   ```

3. Fordítsd le a WPF asztali alkalmazást:
   ```bash
   dotnet build desktop-app/CS2ChatTranslator.csproj -c Release
   ```

4. Teljes hordozható baráti csomag (ZIP) generálása:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\package-for-friends.ps1
   ```
   A generált ZIP és mappa a `dist/` könyvtárban jön létre.

---

## 🔒 Biztonság és VAC Információ

- **A program NEM nyúl a CS2 memóriájához:** Semmilyen DLL injectiont vagy memóriapásztázást nem végez.
- A szoftver a hivatalos Valve `-condebug` kapcsoló által lemezre írt standard szöveges `console.log` fájlt olvassa.
- Az üzenetküldés a standard Source 2 konzol bind (`bind "o" "exec chat_reader.cfg"`) parancson és natív Windows beviteli szimuláción keresztül történik.
- **100%-ban VAC-biztonságos.**

---

## 📄 Licenc

Ez a projekt az [MIT Licenc](LICENSE) alatt érhető el.
