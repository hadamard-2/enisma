# Amharic, Tigrigna and Oromo strings needing a native review

Every non-English `message` value below was written by Claude, not a native speaker, across two sessions (the M3 text-extraction milestone, and the delete/rename/drag-and-drop follow-up). Each entry went through an automated review that checked meaning, grammar, register against neighbouring strings, and character-level fidelity of placeholders — but none of that substitutes for a native read. `context` values (not reproduced here) are identical across all four languages by the catalogue's own rule, since they are notes to a translator rather than translated text; see the `key` to look each one up directly in `src/locales/{am,ti,om}.json`.

Flagged items are real findings from those reviews — start there. Everything else is unflagged but still unverified by a native speaker.

## Priority: known issues

These three are in `center.noTextLayer` and `import.scannedWarning`, Oromo only:

- **`sarara barreeffamaa` renders "text layer" as "text *line*"** — `sarara` means *line*, not *layer*. Amharic (`ንብርብር`) and Tigrigna both use a word that genuinely means *layer*. A better term for "layer" is needed here.
- **"yet" (as in "cannot read scanned text *yet*") comes out as `amma`, meaning "now"** — so it reads "cannot read scanned text now" rather than "not yet, but eventually". Amharic (`እስካሁን`) and Tigrigna (`ክሳብ ሕጂ`) both correctly carry "yet". Something like `hanga ammaatti … hin dandeenye` ("not until now") would fix it.
- **`import.importAnyway` in Oromo, `Haa ta'uyyuu galchi`, is grammatically valid but awkward** — a jussive-plus-suffix construction for "anyway". `Ta'us galchi` reads more naturally. It's also the longest label in the set (19 characters against English's 13); the button already sizes to its content, so this is a wording fix only, not a layout one.

Also worth a look, lower priority: all three non-English `import.scannedWarning` strings turn English's hedged "most pages **would be** empty" into a flat "**will be** empty" — the warning is still accurate, just slightly more absolute than the English original intends.

## Everything else, by key

| Key | English | Amharic | Tigrigna | Oromo |
|---|---|---|---|---|
| `center.noTextLayer` | This page has no text layer, so there is nothing to extract. Enisma cannot read scanned text yet — you can type this page here. | ይህ ገጽ የጽሑፍ ንብርብር የለውም፣ ስለዚህ የሚወሰድ ጽሑፍ የለም። Enisma እስካሁን የተቃኘ ጽሑፍ ማንበብ አይችልም — ይህን ገጽ እዚህ መተየብ ይችላሉ። | እዚ ገጽ ናይ ጽሑፍ ንብርብር የብሉን፣ ስለዚ ዝወጽእ ጽሑፍ የለን። Enisma ስካን ዝተገብረ ጽሑፍ ክሳብ ሕጂ ከንብብ ኣይክእልን — ነዚ ገጽ ኣብዚ ክትጽሕፍ ትኽእል ኢኻ። | Fuulli kun sarara barreeffamaa hin qabu, kanaaf wanti baafamu hin jiru. Enisma barreeffama iskaanii amma dubbisuu hin danda'u — fuula kana as irratti barreessuu dandeessa. *(see flagged issues above)* |
| `center.extracting` | Reading the text from this book… | ከዚህ መጽሐፍ ጽሑፉን በማንበብ ላይ… | ካብዚ መጽሓፍ ጽሑፍ ብምንባብ… | Barreeffama kitaaba kanaa dubbisaa jira… |
| `center.repairError` | Enisma could not re-read this book's text: {error} | Enisma የዚህን መጽሐፍ ጽሑፍ እንደገና ማንበብ አልቻለም፦ {error} | Enisma ናይዚ መጽሓፍ ጽሑፍ ደጊሙ ከንብቦ ኣይከኣለን፦ {error} | Enisma barreeffama kitaaba kanaa irra deebi'ee dubbisuu hin dandeenye: {error} |
| `import.extracting` | Reading the text… | ጽሑፉን በማንበብ ላይ… | ጽሑፍ ብምንባብ… | Barreeffama dubbisaa jira… |
| `import.scannedWarning` | This PDF looks scanned — {empty} of {total} pages have no text layer. Enisma cannot read scanned text yet, so most pages would be empty. | ይህ PDF የተቃኘ ይመስላል — ከ{total} ገጾች {empty} የጽሑፍ ንብርብር የላቸውም። Enisma እስካሁን የተቃኘ ጽሑፍ ማንበብ ስለማይችል፣ አብዛኞቹ ገጾች ባዶ ይሆናሉ። | እዚ PDF ስካን ዝተገብረ ይመስል — ካብ {total} ገጻት {empty} ናይ ጽሑፍ ንብርብር የብለንን። Enisma ስካን ዝተገብረ ጽሑፍ ክሳብ ሕጂ ከንብብ ስለዘይክእል፣ መብዛሕትአን ገጻት ባዶ ክኾና እየን። | PDF kun kan iskaanii fakkaata — fuulota {total} keessaa {empty} sarara barreeffamaa hin qaban. Enisma barreeffama iskaanii amma dubbisuu waan hin dandeenyeef, fuulonni hedduun duwwaa ta'u. *(see flagged issues above)* |
| `import.importAnyway` | Import anyway | ለማንኛውም አስገባ | ብዝኾነ ኣእቱ | Haa ta'uyyuu galchi *(see flagged issues above)* |
| `projectCard.rename` | Rename | ዳግም ሰይም | ስም ቀይር | Maqaa jijjiiri |
| `projectCard.delete` | Delete | ሰርዝ | ደምስስ | Haqi |
| `rename.title` | Rename project | ፕሮጀክቱን ዳግም ሰይም | ናይ ፕሮጀክት ስም ቀይር | Maqaa piroojektii jijjiiri |
| `rename.field` | Title | ርዕስ | ኣርእስቲ | Mata duree |
| `rename.cancel` | Cancel | ሰርዝ አድርግ | ሰርዝ | Dhiisi |
| `rename.confirm` | Save | አስቀምጥ | ኣቐምጥ | Olkaa'i |
| `deleteProject.title` | Delete project? | ፕሮጀክቱ ይሰረዝ? | ፕሮጀክት ይደምሰስ? | Piroojektiin haqamuu? |
| `deleteProject.body` | Deletes "{title}" and Enisma's copy of its PDF. Your original file is untouched. This can't be undone. | "{title}"ን እና የ Enisma የ PDF ቅጂ ይሰርዛል። ዋናው ፋይልዎ አይነካም። ይህ መልሶ አይታደስም። | "{title}"ን ከምኡውን ናይ Enisma ቅዳሕ PDF ይድምስስ። እቲ በዓል ቀደም ፋይልካ ኣይትንከፍን። እዚ ክምለስ ኣይክእልን። | "{title}" fi garagalcha PDF kan Enisma ni haqa. Faayiliin kee inni jalqabaa hin tuqamu. Kun deebi'uu hin danda'u. |
| `deleteProject.cancel` | Cancel | ተወው | ገዲፍካ ውጻእ | Dhiisi |
| `deleteProject.confirm` | Delete | ሰርዝ | ደምስስ | Haqi |
| `library.dropAccept` | Drop to import | ለማስገባት ጣል | ንምእታው ደርቢ | Galchuuf gadi darbi |
| `library.dropReject` | Only PDF files can be imported | PDF ፋይሎች ብቻ ሊገቡ ይችላሉ | PDF ፋይላት ጥራይ ክኣትዋ ይኽእላ | Faayilii PDF qofatu galfamuu danda'a |
| `ttsPanel.convert` | Convert to audio | ወደ ድምፅ ቀይር | ናብ ድምጺ ቀይር | Gara sagaleetti jijjiiri |
| `ttsPanel.converting` | Converting page {n}… | ገጽ {n}ን በመቀየር ላይ… | ገጽ {n} ኣብ ምቕያር… | Fuula {n} jijjiiraa jira… |
| `ttsPanel.cancel` | Cancel | ተወው | ሰርዝ | Dhiisi |
| `ttsPanel.cancelling` | Stopping… | በማቆም ላይ… | ኣብ ምቁራጽ… | Dhaabaa jira… |
| `ttsPanel.stale` | Out of date | ጊዜው ያለፈበት | ግዜኡ ዝሓለፈ | Kan yeroon isaa darbe |
| `ttsPanel.noText` | Nothing to read on this page. | በዚህ ገጽ ላይ የሚነበብ ነገር የለም። | ኣብዚ ገጽ ዝንበብ የለን። | Fuula kana irratti wanti dubbifamu hin jiru. |
| `ttsPanel.convertError` | Enisma could not convert this page: {error} | Enisma ይህን ገጽ መቀየር አልቻለም፦ {error} | Enisma ነዚ ገጽ ክቕይሮ ኣይከኣለን፦ {error} | Enisma fuula kana jijjiiruu hin dandeenye: {error} |
| `ttsPanel.retry` | Try again | እንደገና ሞክር | ደጊምካ ፈትን | Irra deebi'ii yaali |

The `ttsPanel.*` rows above came from the M4 text-to-speech panel and have not been through the automated review the M3 batch had. Two are worth a closer look: `ttsPanel.cancelling` ("Stopping…") describes a stop that has been *requested* but has not happened yet, and all three renderings may read as if it already has; and `ttsPanel.stale` is a badge in a tight space, so a shorter phrasing than Oromo's `Kan yeroon isaa darbe` would help if one exists. The `{error}` in `ttsPanel.convertError` is filled with an untranslated English message from the engine, by design.

## How to fix one

Edit the `message` field for the key in `src/locales/am.json`, `ti.json`, or `om.json` directly — leave `context`, `{placeholders}`, and the key structure untouched. `src/lib/i18n.test.ts` (`bun run test`) checks the four catalogues stay in step, so a typo'd or missing key fails the suite.

## Voice model acquisition (added with the model download and import flow)

Same caveat as everything above: written by Claude, not a native speaker. These carry more product-specific vocabulary than the earlier batches — *install*, *download*, *resume*, *folder* — and that is where a native read matters most, since a borrowed English term may read more naturally than a coined one.

| Key | English | Amharic | Tigrigna | Oromo |
|---|---|---|---|---|
| `modelPanel.heading` | {language} voice | የ{language} ድምጽ | ናይ {language} ድምጺ | Sagalee {language} |
| `modelPanel.missing` | This book cannot be read aloud until its voice is installed — a {total} download, needed once. | የዚህ መጽሐፍ ድምጽ እስኪጫን ድረስ ጮክ ብሎ ሊነበብ አይችልም — {total} ማውረድ፣ አንድ ጊዜ ብቻ የሚያስፈልግ። | ናይዚ መጽሓፍ ድምጺ ክሳብ ዝጽዓን ዓው ኢሉ ክንበብ ኣይክእልን — {total} ምውራድ፣ ሓንሳብ ጥራይ ዘድሊ። | Kitaabni kun hanga sagaleen isaa ijaaramutti sagalee guddaan dubbifamuu hin danda'u — buufannaa {total}, yeroo tokko qofa barbaachisa. |
| `modelPanel.partial` | {already} of {total} is already here. Resuming picks up where it stopped. | ከ{total} ውስጥ {already} አስቀድሞ አለ። መቀጠል ካቆመበት ይጀምራል። | ካብ {total} {already} ድሮ ኣሎ። ምቕጻል ካብ ዝጠጠወሉ ይጅምር። | {total} keessaa {already} duraan as jira. Itti fufuun bakka dhaabatetti fudhata. |
| `modelPanel.unloadable` | The voice is installed but could not be loaded. Reinstalling it is worth a try. | ድምጹ ተጭኗል ነገር ግን ሊጫን አልቻለም። እንደገና መጫን መሞከር ተገቢ ነው። | ድምጺ ተጻዒኑ ኣሎ ግን ክጽዕን ኣይከኣለን። ደጊምካ ምጽዓን ክፍተን ይግባእ። | Sagaleen ni ijaarame garuu fe'amuu hin dandeenye. Irra deebi'anii ijaaruun yaalamuu qaba. |
| `modelPanel.failed` | Installing failed: {error} | መጫን አልተሳካም፦ {error} | ምጽዓን ኣይተዓወተን፦ {error} | Ijaaruun hin milkoofne: {error} |
| `modelPanel.installing` | Installing the {language} voice… | የ{language} ድምጽ በመጫን ላይ… | ናይ {language} ድምጺ ብምጽዓን… | Sagalee {language} ijaaraa jira… |
| `modelPanel.installingSize` | {total} in total | በአጠቃላይ {total} | ብድምር {total} | Walumaagalatti {total} |
| `modelPanel.download` | Download | አውርድ | ኣውርድ | Buufadhu |
| `modelPanel.resume` | Resume | ቀጥል | ቀጽል | Itti fufi |
| `modelPanel.retry` | Try again | እንደገና ሞክር | ደጊምካ ፈትን | Irra deebi'ii yaali |
| `modelPanel.reinstall` | Reinstall | እንደገና ጫን | ደጊምካ ጸዓን | Irra deebi'ii ijaari |
| `modelPanel.import` | From folder | ከአቃፊ | ካብ ፋይል ኣቃፊ | Faayilii irraa |
| `modelPanel.importTooltip` | Install from a folder you already have — for a machine with no connection. | አስቀድመው ካለዎት አቃፊ ይጫኑ — ግንኙነት ለሌለው ማሽን። | ድሮ ካብ ዘለካ ኣቃፊ ጽዓን — ርክብ ንዘይብሉ ማሽን። | Faayilii duraan qabdu irraa ijaari — maashinii walqunnamtii hin qabneef. |
| `modelPanel.cancel` | Cancel | ሰርዝ | ሰርዝ | Dhiisi |
| `modelPanel.cancelling` | Cancelling… | በመሰረዝ ላይ… | ብምስራዝ… | Dhiisaa jira… |
