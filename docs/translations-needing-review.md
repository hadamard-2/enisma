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

## Voice names and the audio player (added with the voice labels and real waveform)

Written by Claude, not reviewed by a native speaker. Three things to check first:

- **The voice names are proper names, transliterated, not translated** — Abebe for Amharic, Tesfay for Tigrigna, Gemechu for Oromo. They are placeholders for whatever names you actually want; changing one is a one-line edit per locale under `voices.name`. The Oromo-interface spellings (`Tesfaay`, `Gammachuu`) are Qubee transliterations I am not confident of, and `Abebe` is left in its common Latin form there because I could not settle its Qubee spelling.
- **The accent and gender labels are shown as adjectives after a voice's name** (`Heart · American · Female`). Check that `አሜሪካዊ` / `ኣመሪካዊ` / `Ameerikaa` and the gender words read naturally in that position — grammatical gender agreement with an implied "voice" noun may call for a different form.
- **`ttsPanel.position` is a screen-reader label only**, never seen on screen.

| Key | English | Amharic | Tigrigna | Oromo |
|---|---|---|---|---|
| `voices.accent.american` | American | አሜሪካዊ | ኣመሪካዊ | Ameerikaa |
| `voices.accent.british` | British | እንግሊዛዊ | እንግሊዛዊ | Ingiliz |
| `voices.gender.female` | Female | ሴት | ኣንስተይቲ | Dubartii |
| `voices.gender.male` | Male | ወንድ | ተባዕታይ | Dhiira |
| `voices.name.am` | Abebe | አበበ | ኣበበ | Abebe |
| `voices.name.ti` | Tesfay | ተስፋይ | ተስፋይ | Tesfaay |
| `voices.name.om` | Gemechu | ገመቹ | ገመቹ | Gammachuu |
| `ttsPanel.audioLoadError` | Enisma could not load this page's audio: {error} | Enisma የዚህን ገጽ ድምፅ መጫን አልቻለም፦ {error} | Enisma ናይዚ ገጽ ድምጺ ክጽዕን ኣይከኣለን፦ {error} | Enisma sagalee fuula kanaa fe'uu hin dandeenye: {error} |
| `ttsPanel.position` | Playback position | የማጫወቻ ቦታ | ቦታ ምጽዋት | Bakka taphachiisaa |

`center.unsavedChanges` was removed in the same change: autosave made the indicator pointless. Its three translations no longer need review.

## Save failures (added when the "unsaved changes" indicator was replaced)

Written by Claude, not reviewed by a native speaker. It continues the footer line in lowercase, after the word count. The second half is an instruction: the edit is re-sent by the next keystroke, not automatically.

| Key | English | Amharic | Tigrigna | Oromo |
|---|---|---|---|---|
| `center.saveFailed` | not saved — keep typing to retry | አልተቀመጠም — እንደገና ለመሞከር መተየብዎን ይቀጥሉ | ኣይተዓቀበን — ንምድጋም ምጽሓፍ ቀጽል | hin olkaa'amne — irra deebi'uuf barreessuu itti fufi |

## Player controls (added with the start/end and 5-second buttons)

Written by Claude, not reviewed by a native speaker. Tooltips and screen-reader labels only. `ttsPanel.rewind` was removed, and `ttsPanel.forward` changed meaning: it used to be a bare "Forward", and now takes a `{seconds}` count.

| Key | English | Amharic | Tigrigna | Oromo |
|---|---|---|---|---|
| `ttsPanel.toStart` | Go to start | ወደ መጀመሪያ | ናብ መጀመርታ | Gara jalqabaatti |
| `ttsPanel.back` | Back {seconds} seconds | {seconds} ሰከንድ ወደኋላ | {seconds} ካልኢት ንድሕሪት | Sekondii {seconds} duubatti |
| `ttsPanel.forward` | Forward {seconds} seconds | {seconds} ሰከንድ ወደፊት | {seconds} ካልኢት ንቕድሚት | Sekondii {seconds} fuulduratti |
| `ttsPanel.toEnd` | Go to end | ወደ መጨረሻ | ናብ መወዳእታ | Gara dhumaatti |

## Search (added with page find and book search)

Written by Claude, not reviewed by a native speaker. `search.summary` uses ICU plurals in English only; the Amharic, Tigrigna and Oromo versions use one plural form for every count, which reads oddly for 1 ("1 ውጤቶች") — worth fixing with proper plural wrappers.

| Key | English | Amharic | Tigrigna | Oromo |
|---|---|---|---|---|
| `find.placeholder` | Find on this page | በዚህ ገጽ ላይ ፈልግ | ኣብዚ ገጽ ድለ | Fuula kana irratti barbaadi |
| `find.count` | {current} of {total} | {current} ከ{total} | {current} ካብ {total} | {current} kan {total} |
| `find.none` | No results | ምንም ውጤት የለም | ውጽኢት የለን | Bu'aan hin jiru |
| `find.previous` | Previous match | ቀዳሚ ውጤት | ዝሓለፈ ውጽኢት | Bu'aa duraa |
| `find.next` | Next match | ቀጣይ ውጤት | ዝቕጽል ውጽኢት | Bu'aa itti aanu |
| `find.close` | Close | ዝጋ | ዕጸው | Cufi |
| `search.placeholder` | Search this book | በዚህ መጽሐፍ ውስጥ ፈልግ | ኣብዚ መጽሓፍ ድለ | Kitaaba kana keessa barbaadi |
| `search.summary` | {count, plural, one {# match} other {# matches}} on {pages, plural, one {# page} other {# pages}} | {count} ውጤቶች በ{pages} ገጾች | {count} ውጽኢታት ኣብ {pages} ገጻት | Bu'aa {count} fuula {pages} irratti |
| `search.none` | No matches in this book | በዚህ መጽሐፍ ውስጥ ምንም ውጤት የለም | ኣብዚ መጽሓፍ ውጽኢት የለን | Kitaaba kana keessatti bu'aan hin jiru |
| `search.page` | Page {n} | ገጽ {n} | ገጽ {n} | Fuula {n} |
| `search.loading` | Reading the book… | መጽሐፉን በማንበብ ላይ… | መጽሓፍ ብምንባብ… | Kitaabni dubbifamaa jira… |
| `search.error` | Enisma could not read this book's text: {error} | Enisma የዚህን መጽሐፍ ጽሑፍ ማንበብ አልቻለም፦ {error} | Enisma ናይዚ መጽሓፍ ጽሑፍ ከንብብ ኣይከኣለን፦ {error} | Enisma barreeffama kitaaba kanaa dubbisuu hin dandeenye: {error} |
| `search.hint` | Type to search every page of this book | የዚህን መጽሐፍ ገጾች በሙሉ ለመፈለግ ይተይቡ | ኩሎም ገጻት ናይዚ መጽሓፍ ንምድላይ ጽሓፍ | Fuulota kitaaba kanaa hunda barbaaduuf barreessi |

## Edit menu search items

| Key | English | Amharic | Tigrigna | Oromo |
|---|---|---|---|---|
| `menu.find` | Find | ፈልግ | ድለ | Barbaadi |
| `menu.findInBook` | Find in book | በመጽሐፉ ውስጥ ፈልግ | ኣብ መጽሓፍ ድለ | Kitaaba keessa barbaadi |

## M5 export strings (2026-09-23)

Every non-English `message` below was written by Claude, not a native speaker, and needs a native read. The `menu.exportAudiobook` context changed too (the message did not), so its existing translations are unchanged.

**Priority:**

- **Oromo `sagalee` means both "voice" and "audio"**, so `export.replacing` reads "sagalee sagalee …" ("audio of voice …"). It's intelligible but clumsy; a native speaker may prefer a distinct word for the audio (a recording) here.
- **"synthesize" in `export.plan`** is rendered as "to be read (aloud)" in all three languages (`የሚነበቡ`, `ዝንበባ`, `kan dubbifamu`) rather than a technical term, matching the app's "read aloud" wording elsewhere. Check it reads as a count label.
- **Oromo drops the plural wrapper** in `plan`, `replacing`, `emptyPages` and `cancelledBody`, per the catalogue rule. In `emptyPages` that means the singular noun `Fuulni {pages}` is used even for a list of pages; check that this reads naturally for "Pages 4, 7, 9".
- **"Export" as a verb** follows the existing `menu.exportAudiobook` choice (`አውጣ`, `ኣውጽእ`, `baasi` — literally "take out"). If that menu item is reworded, these should follow.

| Key | English | Amharic | Tigrigna | Oromo |
|---|---|---|---|---|
| `export.title` | Export audiobook | የድምጽ መጽሐፍ አውጣ | ናይ ድምጺ መጽሓፍ ኣውጽእ | Kitaaba sagalee baasi |
| `export.voice` | Voice | ድምጽ | ድምጺ | Sagalee |
| `export.speed` | Speaking rate | የንግግር ፍጥነት | ናይ ንግግር ፍጥነት | Saffisa dubbii |
| `export.pages` | Pages | ገጾች | ገጻት | Fuulota |
| `export.wholeBook` | Whole book | ሙሉ መጽሐፉ | ምሉእ መጽሓፍ | Kitaaba guutuu |
| `export.pageRange` | Pages | ገጾች | ገጻት | Fuulota |
| `export.rangeTo` | to | እስከ | ክሳብ | hanga |
| `export.plan` | {total, plural, one {# page} other {# pages}} · {ready} ready · {toSynthesize} to synthesize · {empty} empty | {total, plural, one {# ገጽ} other {# ገጾች}} · {ready} ዝግጁ · {toSynthesize} የሚነበቡ · {empty} ባዶ | {total, plural, one {# ገጽ} other {# ገጻት}} · {ready} ድሉዋት · {toSynthesize} ዝንበባ · {empty} ባዶ | Fuula {total} · {ready} qophaa'e · {toSynthesize} kan dubbifamu · {empty} duwwaa |
| `export.replacing` | {count, plural, one {# page has audio in another voice or speed. Exporting replaces it.} other {# pages have audio in another voice or speed. Exporting replaces it.}} | {count, plural, one {# ገጽ በሌላ ድምጽ ወይም ፍጥነት የተሰራ ድምፅ አለው። ማውጣት ይተካዋል።} other {# ገጾች በሌላ ድምጽ ወይም ፍጥነት የተሰራ ድምፅ አላቸው። ማውጣት ይተካዋል።}} | {count, plural, one {# ገጽ ብካልእ ድምጺ ወይ ፍጥነት ዝተሰርሐ ድምጺ ኣለዎ። ምውጻእ ይትክኦ።} other {# ገጻት ብካልእ ድምጺ ወይ ፍጥነት ዝተሰርሐ ድምጺ ኣለወን። ምውጻእ ይትክኦ።}} | Fuulli {count} sagalee sagalee ykn saffisa biraatiin hojjetame qabu. Baasuun isa bakka buusa. |
| `export.modelMissing` | Install the {language} voice from the audio panel before exporting. | ከማውጣትዎ በፊት የ{language} ድምጽን ከድምጽ ፓነሉ ይጫኑ። | ቅድሚ ምውጻእካ ናይ {language} ድምጺ ካብ ፓነል ድምጺ ኣውርድ። | Osoo hin baasin dura sagalee {language} paanaalii sagalee irraa fe'i. |
| `export.nothingToExport` | Every page in this range is empty. | በዚህ ክልል ውስጥ ያሉት ሁሉም ገጾች ባዶ ናቸው። | ኣብዚ ክፍሊ ዘለዋ ኩለን ገጻት ባዶ እየን። | Fuulonni daangaa kana keessa jiran hundi duwwaa dha. |
| `export.invalidRange` | Choose pages within this book. | በዚህ መጽሐፍ ውስጥ ያሉ ገጾችን ይምረጡ። | ኣብዚ መጽሓፍ ዘለዋ ገጻት ምረጽ። | Fuulota kitaaba kana keessa jiran filadhu. |
| `export.cancel` | Cancel | ተወው | ሰርዝ | Dhiisi |
| `export.start` | Export… | አውጣ… | ኣውጽእ… | Baasi… |
| `export.progressTitle` | Exporting {title} | {title}ን በማውጣት ላይ | {title} ኣብ ምውጻእ | {title} baasaa jira |
| `export.phaseStarting` | Getting ready… | በመዘጋጀት ላይ… | ኣብ ምድላው… | Qophaa'aa jira… |
| `export.phaseReading` | Reading page {page} ({done} of {total}) | ገጽ {page}ን በማንበብ ላይ (ከ{total} {done}) | ገጽ {page} ኣብ ምንባብ ({done} ካብ {total}) | Fuula {page} dubbisaa jira ({total} keessaa {done}) |
| `export.phaseChecking` | Checking for edits · page {page} | ለውጦችን በማረጋገጥ ላይ · ገጽ {page} | ለውጥታት ኣብ ምፍታሽ · ገጽ {page} | Jijjiirama mirkaneessaa jira · fuula {page} |
| `export.phaseWriting` | Writing MP3 | MP3 በመጻፍ ላይ | MP3 ኣብ ምጽሓፍ | MP3 barreessaa jira |
| `export.elapsed` | {time} elapsed | {time} አልፏል | {time} ሓሊፉ | {time} darbeera |
| `export.timeLeft` | about {time} left | {time} ገደማ ቀርቷል | ዳርጋ {time} ተሪፉ | gara {time} hafeera |
| `export.stop` | Cancel export | ማውጣቱን አቁም | ምውጻእ ኣቋርጽ | Baasuu dhaabi |
| `export.stopping` | Stopping… | በማቆም ላይ… | ኣብ ምቁራጽ… | Dhaabaa jira… |
| `export.hide` | Hide | ደብቅ | ሕባእ | Dhoksi |
| `export.doneTitle` | Audiobook ready | የድምጽ መጽሐፉ ዝግጁ ነው | ናይ ድምጺ መጽሓፍ ድሉው እዩ | Kitaabni sagalee qophaa'eera |
| `export.savedTo` | Saved to {path} | በ{path} ተቀምጧል | ኣብ {path} ተዓቂቡ | {path} irratti olkaa'ameera |
| `export.duration` | Length {time} | ርዝመት {time} | ንውሓት {time} | Dheerina {time} |
| `export.showInFolder` | Show in folder | በአቃፊ ውስጥ አሳይ | ኣብ ፎልደር ኣርኢ | Kuusaa keessatti agarsiisi |
| `export.emptyPages` | {count, plural, one {Page {pages} had no text and was skipped.} other {Pages {pages} had no text and were skipped.}} | {count, plural, one {ገጽ {pages} ጽሑፍ ስላልነበረው ተዘልሏል።} other {ገጾች {pages} ጽሑፍ ስላልነበራቸው ተዘልለዋል።}} | {count, plural, one {ገጽ {pages} ጽሑፍ ስለዘይነበሮ ተሳጊሩ።} other {ገጻት {pages} ጽሑፍ ስለዘይነበረን ተሳጊረን።}} | Fuulni {pages} barreeffama waan hin qabneef irra darbameera. |
| `export.failedTitle` | Some pages could not be read | አንዳንድ ገጾች ሊነበቡ አልቻሉም | ገለ ገጻት ክንበባ ኣይከኣላን | Fuulonni tokko tokko dubbifamuu hin dandeenye |
| `export.failedBody` | Fix these pages and export again. Only they will be read again. | እነዚህን ገጾች አስተካክለው እንደገና ያውጡ። እንደገና የሚነበቡት እነሱ ብቻ ናቸው። | ነዘን ገጻት ኣዐርየን ደጊምካ ኣውጽእ። ደጊመን ዝንበባ ንሳተን ጥራይ እየን። | Fuulota kana sirreessiitii irra deebi'ii baasi. Isaan qofatu irra deebi'amee dubbifama. |
| `export.pageLink` | Page {n} | ገጽ {n} | ገጽ {n} | Fuula {n} |
| `export.cancelledTitle` | Export stopped | ማውጣቱ ቆሟል | ምውጻእ ተቋሪጹ | Baasuun dhaabbateera |
| `export.cancelledBody` | {count, plural, one {# page was finished and is kept.} other {# pages were finished and are kept.}} | {count, plural, one {# ገጽ ተጠናቅቆ ተቀምጧል።} other {# ገጾች ተጠናቅቀው ተቀምጠዋል።}} | {count, plural, one {# ገጽ ተዛዚሙ ተዓቂቡ ኣሎ።} other {# ገጻት ተዛዚመን ተዓቂበን ኣለዋ።}} | Fuulni {count} xumuramee olkaa'ameera. |
| `export.errorTitle` | Export stopped | ማውጣቱ ቆሟል | ምውጻእ ተቋሪጹ | Baasuun dhaabbateera |
| `export.errorBody` | Finished pages are kept. Export again to continue. | የተጠናቀቁ ገጾች ተቀምጠዋል። ለመቀጠል እንደገና ያውጡ። | ዝተዛዘማ ገጻት ተዓቂበን ኣለዋ። ንምቕጻል ደጊምካ ኣውጽእ። | Fuulonni xumuraman olkaa'amaniiru. Itti fufuuf irra deebi'ii baasi. |
| `export.close` | Close | ዝጋ | ዕጸው | Cufi |
| `export.again` | Export again | እንደገና አውጣ | ደጊምካ ኣውጽእ | Irra deebi'ii baasi |
| `export.pillRunning` | Exporting · {percent}% | በማውጣት ላይ · {percent}% | ኣብ ምውጻእ · {percent}% | Baasaa jira · {percent}% |
| `export.pillReady` | Export ready | ማውጣቱ ዝግጁ ነው | ምውጻእ ድሉው እዩ | Baasuun qophaa'eera |
| `export.pillAttention` | Export needs attention | ማውጣቱ ትኩረት ይፈልጋል | ምውጻእ ኣቓልቦ የድልዮ | Baasuun xiyyeeffannaa barbaada |
| `export.quitTitle` | An export is running | ማውጣት በሂደት ላይ ነው | ምውጻእ ይካየድ ኣሎ | Baasuun adeemsa irra jira |
| `export.quitBody` | Quit anyway? Finished pages are kept, and exporting again continues from there. | ቢሆንም ይውጡ? የተጠናቀቁ ገጾች ይቀመጣሉ፣ እንደገና ሲያወጡ ከዚያ ይቀጥላል። | ብዝኾነ ክትወጽእ? ዝተዛዘማ ገጻት ይዕቀባ፣ ደጊምካ ምስ ኣውጻእካ ካብኡ ይቕጽል። | Ta'us baatta? Fuulonni xumuraman ni olkaa'amu, irra deebitee yoo baaste achii itti fufa. |
| `export.keepExporting` | Keep exporting | ማውጣቱን ቀጥል | ምውጻእ ቀጽል | Baasuu itti fufi |
| `export.quitAnyway` | Quit | ውጣ | ውጻእ | Bahi |

## M6 voice management strings (2026-09-25)

The Settings → Voices list and the delete-voice confirmation. Every non-English `message` below was written by Claude and needs a native read. Terms were reused from each catalogue's existing `modelPanel` (install/download) and `deleteProject` (delete/cancel) entries so they match.

**Priority:**

- **`deleteVoice.body`, all three** — the English separates "audio you've already made" (kept) from "making new audio" (needs the model). Check that each translation keeps that distinction clear, since it is the whole point of the dialog. In Oromo, `{language}n` attaches an instrumental suffix to the placeholder; with names like "Afaan Oromoo" this may read oddly.
- **"Installed" in Amharic (`ተጭኗል`) and "could not be loaded" (`ሊጫን አልቻለም`) use the same verb** — `modelPanel.unloadable` already does this, so it is consistent, but `voiceUnloadable` ("installed, but could not be loaded") may read as a contradiction. The same applies to Tigrigna `ተጻዒኑ … ክጽዕን ኣይከኣለን`.
- **`settings.voices` plural** — `ድምጾች`, `ድምጽታት` and `Sagaleewwan` are plausible plurals of the existing "voice" terms but have not appeared elsewhere in the catalogues.

| Key | English | Amharic | Tigrigna | Oromo |
|---|---|---|---|---|
| `settings.voices` | Voices | ድምጾች | ድምጽታት | Sagaleewwan |
| `settings.voicesUnavailable` | Voices can't be listed until the app has finished starting. | መተግበሪያው መጀመሩን እስኪጨርስ ድረስ ድምጾች ሊዘረዘሩ አይችሉም። | እቲ መተግበሪ ምጅማሩ ክሳብ ዝውድእ ድምጽታት ክዝርዘሩ ኣይክእሉን። | Hanga appiin jalqabuu xumurutti sagaleewwan tarreeffamuu hin danda'an. |
| `settings.voiceInstalled` | Installed · {size} | ተጭኗል · {size} | ተጻዒኑ · {size} | Ijaarameera · {size} |
| `settings.voiceMissing` | Not installed · {size} download | አልተጫነም · {size} ማውረድ | ኣይተጻዕነን · {size} ምውራድ | Hin ijaaramne · buufannaa {size} |
| `settings.voicePartial` | {already} of {total} downloaded | ከ{total} ውስጥ {already} ወርዷል | ካብ {total} {already} ወሪዱ | {total} keessaa {already} buufameera |
| `settings.voiceUnloadable` | Installed, but could not be loaded | ተጭኗል፣ ነገር ግን ሊጫን አልቻለም | ተጻዒኑ፣ ግን ክጽዕን ኣይከኣለን | Ijaarameera, garuu fe'amuu hin dandeenye |
| `settings.voiceInstalling` | Installing… {percent}% | በመጫን ላይ… {percent}% | ብምጽዓን… {percent}% | Ijaaraa jira… {percent}% |
| `settings.voiceDelete` | Delete | ሰርዝ | ደምስስ | Haqi |
| `deleteVoice.title` | Delete voice? | ድምጹ ይሰረዝ? | ድምጺ ይደምሰስ? | Sagaleen haqamuu? |
| `deleteVoice.body` | Delete the {language} voice ({size})? Audio you've already made keeps playing; making new audio in {language} will need it again. | የ{language} ድምጽ ({size}) ይሰረዝ? አስቀድመው የሠሩት ድምጽ መጫወቱን ይቀጥላል፤ በ{language} አዲስ ድምጽ መሥራት ግን እንደገና ይፈልገዋል። | ናይ {language} ድምጺ ({size}) ይደምሰስ? ድሮ ዝሰራሕካዮ ድምጺ ምጽዋቱ ይቕጽል፤ ብ{language} ሓድሽ ድምጺ ምስራሕ ግን ደጊሙ የድልዮ። | Sagalee {language} ({size}) haquu? Sagaleen ati duraan hojjette taphachuu itti fufa; sagalee haaraa {language}n hojjechuun garuu irra deebi'ee isa barbaada. |
| `deleteVoice.cancel` | Cancel | ተወው | ገዲፍካ ውጻእ | Dhiisi |
| `deleteVoice.confirm` | Delete | ሰርዝ | ደምስስ | Haqi |
