# 🚀 Útmutató: Feltöltés GitHub-ra lépésről lépésre

Ez az útmutató segít feltölteni a **CS2 Chat Translator** projektet a saját GitHub fiókodba.

A repó már elő van készítve:
- ✅ Modern, részletes [README.md](README.md) magyar leírással, képekkel és funkciókkal
- ✅ Hivatalos [MIT Licenc](LICENSE)
- ✅ Gondosan beállított [.gitignore](.gitignore) (nem fogja feltölteni a felesleges `node_modules` mappát, a több száz megás ZIP-et és az ideiglenes build fájlokat)

---

## 1. Lépés: Új tároló (Repository) létrehozása a GitHub-on

1. Nyisd meg a böngésződben a [github.com/new](https://github.com/new) oldalt.
2. Jelentkezz be a fiókodba (ha még nem vagy bejelentkezve).
3. Töltsd ki az adatokat:
   - **Repository name**: `cs2-chat-translator`
   - **Description**: `Valós idejű Counter-Strike 2 chat fordító és HUD overlay Windowsra`
   - **Láthatóság**: Válassz **Public** (nyilvános) vagy **Private** (privát) lehetőséget.
4. **FONTOS:** A következő pipákat **HAGYD ÜRESEN** (ne pipáld be őket, mert a fájlok már léteznek a gépeden):
   - ❌ *Add a README file* (NE pipáld be!)
   - ❌ *Add .gitignore* (NE pipáld be!)
   - ❌ *Choose a license* (NE pipáld be!)
5. Kattints a zöld **Create repository** gombra.

---

## 2. Lépés: Feltöltés a gépedről (Terminál / PowerShell)

Nyiss egy **PowerShell** vagy **Parancssor** ablakot, és másold be az alábbi parancsokat egymás után:

### A) Lépj be a projekt mappájába:
```powershell
cd "C:\Users\istva\Documents\cs2-chat-translator"
```

### B) Git felhasználó beállítása (ha még nem volt beállítva):
*(A saját GitHub neveddel és e-maileddel helyettesítsd be!)*
```powershell
git config --global user.name "A-Te-GitHub-Neved"
git config --global user.email "a-te-email-cimed@example.com"
```

### C) Fájlok hozzáadása és mentése (Commit):
```powershell
git add .
git commit -m "Initial commit: CS2 Chat Translator v1.3.0"
```

### D) Összekapcsolás a GitHub tárolóddal:
*(A `FELHASZNALONEVED` helyére írd a saját GitHub felhasználóneved!)*
```powershell
git remote add origin https://github.com/FELHASZNALONEVED/cs2-chat-translator.git
git branch -M main
git push -u origin main
```

Amikor kéri, jelentkezz be a felugró GitHub ablakban a böngésződdel.

---

## 3. Lépés (Opcionális): A Portable ZIP csomag közzététele a Releases fülön

Mivel a barátoknak készített `CS2-Chat-Translator-Portable.zip` mérete ~105 MB, a Git forráskódba a `.gitignore` miatt nem kerül bele (a forráskódtárakba nem szokás több száz megás binárisokat pusholni). 

Helyette érdemes kirakni a letölthető **Releases** fülre:
1. Menj a feltöltött GitHub repód főoldalára.
2. Jobb oldalon kattints a **Releases** $\rightarrow$ **Create a new release** gombra.
3. **Choose a tag**: írd be: `v1.3.0` $\rightarrow$ kattints a *Create new tag* gombra.
4. **Release title**: `CS2 Chat Translator v1.3.0 - Hordozható kiadás`
5. Húzd be a `C:\Users\istva\Documents\cs2-chat-translator\dist\CS2-Chat-Translator-Portable.zip` fájlt az *Attach binaries by dropping them here* mezőbe.
6. Kattints a **Publish release** gombra.

Így a barátaidnak elég csak a Release linkjét elküldened, és egy kattintással letölthetik a kész, futtatható programot!
