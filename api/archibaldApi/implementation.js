var { classes: Cc, interfaces: Ci } = Components;

// ESM imports that should work in TB 115+/128/140+/153+
const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
const { MailServices } = globalThis.MailServices
  ? globalThis
  : ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { FolderUtils } = ChromeUtils.importESModule("resource:///modules/FolderUtils.sys.mjs");

// Use Window Mediator via XPCOM (avoids Services import)
const WM = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
const F = Ci.nsMsgFolderFlags;

// ================================= HELPERS ============================================
function getTopChromeWindow()
{
  return WM.getMostRecentWindow("mail:3pane") || WM.getMostRecentWindow(null);
}

function initPickerWithParent(picker, parentWin, title, modeConst)
{
  const bc = parentWin?.browsingContext;
  try {
    if (bc) { picker.init(bc, title, modeConst); return; }
  }
  catch (_) {}
  picker.init(parentWin, title, modeConst);
}

function getAccountById(accountId)
{
  // MailServices.accounts.accounts is an nsIArray of nsIMsgAccount
  for (const account of MailServices.accounts.accounts)
  {
    if (account.key === accountId)
      return account;
  }
  return null;
}

function sanitizeName(str)
{
  let s = String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // strip accents
  // allow only a-z, 0-9, hyphen, dot; turn everything else into hyphen
  s = s.replace(/[^a-zA-Z0-9.-]+/g, "-")
       .replace(/-+/g, "-")               // collapse hyphens
       .replace(/^[.-]+|[.-]+$/g, "")     // trim leading/trailing dots/hyphens
       .toLowerCase();
  if (!/^[a-z0-9]/.test(s)) s = "x-" + s; // must start with alnum
  if (s.length > 60) s = s.slice(0, 60);  // keep it short
  return s || "x-local";
}

// Minimal async sleep that works in Thunderbird’s chrome context
function sleep(ms)
{
  return new Promise(resolve => {
    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.init(() => resolve(), ms, Ci.nsITimer.TYPE_ONE_SHOT);
  });
}

async function ensureSpecialSubfolder(parent, name, flag)
{
  try { parent.createSubfolder(name, null); } catch (_) {}
  let f = null;
  for (let i = 0; i < 10 && !f; i++)
  {
    try { f = parent.getChildNamed(name); } catch (_) {}
    if (!f)
    {
      try { parent.updateFolderWithListener(null, null); } catch (_) {}
      await sleep(50); // yield so TB can process folder creation
    }
  }

  if (!f)
    return;

  try { f = f.QueryInterface(Ci.nsIMsgFolder); } catch (_) {}
  try { f.setFlag ? f.setFlag(flag) : (f.flags |= flag); } catch (_) {}
  try { if (f instanceof Ci.nsIMsgLocalMailFolder) f.createStorageIfMissing(null); } catch (_) {}
  try { f.updateFolderWithListener(null, null); } catch (_) {}

  return f;
}

// We need to make sure the mbox layout is correct to move messages to folders
function forceMboxLayoutFix(folder)
{
    // Ensure we have the local mail folder interface.
    let localFolder;
    try {
        localFolder = folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
    } catch (e) {
        console.warn("[Archibald] - Folder is not local mail folder.", e);
        return;
    }

    const mbox = localFolder.filePath;
    const parentDir = mbox.parent;
    const sbd = mbox.clone();
    sbd.leafName = mbox.leafName + ".sbd";

    // If the path is a directory, it must be renamed to .sbd.
    if (mbox.exists() && mbox.isDirectory()) {
        if (!sbd.exists()) {
            // Case 1: Trash/ exists, Trash.sbd/ does not. Rename Trash/ -> Trash.sbd/
            mbox.moveTo(parentDir, mbox.leafName + ".sbd");
            console.log("[Archibald] - Renamed stray directory to .sbd.");
        } else {
            // Case 2: Both exist. Move contents and remove the stray directory.
            const it = mbox.directoryEntries;
            while (it.hasMoreElements()) {
                const child = it.getNext().QueryInterface(Ci.nsIFile);
                child.moveTo(sbd, child.leafName);
            }
            mbox.remove(true);
            console.log("[Archibald] - Cleaned up stray directory contents.");
        }
    }

    // Make sure mbox file exists
    if (!mbox.exists()) {
        try {
            //Try to use the API (Should work now that the path is clear)
            localFolder.createStorageIfMissing(null);
            console.log("[Archibald] - createStorageIfMissing succeeded.");
        } catch (e) {
            console.warn("[Archibald] - createStorageIfMissing failed, using fallback:", e);
        }
    }

    // Fallback: Use direct file creation if the API still failed.
    if (!mbox.exists()) {
         try {
             mbox.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
             console.log("[Archibald] - Direct Mbox file creation successful.");
         } catch (e) {
             console.error("[Archibald] - FATAL: Direct file creation failed. Permissions issue?", e);
             return;
         }
    }

    // Ensure .sbd exists for future subfolders
    if (!sbd.exists()) {
        try { sbd.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700); } catch (_) {}
    }

    // Final synchronization (synchronous touch)
    try { void localFolder.msgDatabase; } catch (_) {}
    try { localFolder.updateFolderWithListener(null, null); } catch (_) {}

    //console.log("[Archibald] - Layout fix complete. Mbox file guaranteed.");
}

async function ensureSubfolder(parent, name)
{
    // Normalize parent
    try { parent = parent.QueryInterface(Ci.nsIMsgFolder); }
    catch (_) {}

    // Create (ok if it already exists)
    try
    {
      parent.createSubfolder(name, null);
    }
    catch (e)
    {
      // ignore "already exists" etc.
      //console.log("createSubfolder failed: " + name + e)
    }

    // Find it (Allow async cycles for TB to register the new child)
    let f = null;
    for (let i = 0; i < 10 && !f; i++)
    {
        try { f = parent.getChildNamed(name); } catch (_) {}

        if (!f) {
            try { parent.updateFolderWithListener(null, null); } catch (_) {}
            await sleep(50); // Keep async wait here for folder object creation
        }
    }
    if (!f)
        return null;

    try { f = f.QueryInterface(Ci.nsIMsgFolder); } catch (_) {}

    // Ensure Mbox Layout is correct for local accounts
    try
    {
        const server = f.server;
        const isLocalish = server && (server.type === "none" || server.type === "pop3");

        if (isLocalish)
        {
          // Await the synchronous fix to ensure disk operations finish
          await forceMboxLayoutFix(f);
        }
        else
        {
          // Non-local accounts: just ensure storage/DB exists if it's a local folder
          try
          {
              const local = f.QueryInterface(Ci.nsIMsgLocalMailFolder);
              local.createStorageIfMissing(null);
          }
          catch (_) {}
          try { void f.msgDatabase; } catch (_) {}
        }
    }
    catch (e)
    {
        console.warn("[Archibald] ensureSubfolder layout fix failed:", e);
    }

    // Let TB refresh this folder’s state
    try { f.updateFolderWithListener(null, null); } catch (_) {}

    return f; // nsIMsgFolder, with a real mbox backing file for local accounts
}

async function rebuildFolderDBs(folder)
{
  //console.log("[Archibald] - Rebuilding DB for:", folder.name);
  try
  {
    const local = folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
    if (typeof local.forceDBClosed === "function")
      local.forceDBClosed();
  }
  catch (e)
  {
    // Not a local folder or forceDBClosed not exposed – ignore
  }

  try
  {
    if (typeof folder.updateFolderWithListener === "function")
      folder.updateFolderWithListener(null, null);

    else if (typeof folder.updateFolder === "function")
      folder.updateFolder(null);
  }
  catch (e)
  {
    // This is not critical, no need to spam console
    // console.warn("[Archibald] - updateFolder failed for", folder.name, ":", e);
  }

  // Recurse into subfolders
  const s = folder.subFolders;
  if (!s)
    return;

  if (typeof s.hasMoreElements === "function")
  {
    while (s.hasMoreElements())
    {
      let sf = s.getNext();
      try { sf = sf.QueryInterface(Ci.nsIMsgFolder); } catch (_) {}
      await rebuildFolderDBs(sf);
    }
  }
  else if (Symbol.iterator in Object(s))
  {
    for (let sf of s)
    {
      try { sf = sf.QueryInterface(Ci.nsIMsgFolder); } catch (_) {}
      await rebuildFolderDBs(sf);
    }
  }
}

async function repairMboxLayout(nsFolder /* nsIMsgFolder */)
{
  nsFolder = nsFolder.QueryInterface(Ci.nsIMsgFolder);
  const local = nsFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

  // Paths
  const mbox = local.filePath; // C:\...\Archives   (should be a FILE)
  const parentDir = mbox.parent;
  const sbd = mbox.clone(); sbd.leafName = mbox.leafName + ".sbd";

  // If the mbox "file" is actually a DIRECTORY, convert layout:
  if (mbox.exists() && mbox.isDirectory())
  {
    // If Archives.sbd doesn't exist yet, turn the wrong dir into the .sbd
    if (!sbd.exists())
      mbox.moveTo(parentDir, mbox.leafName + ".sbd"); // Archives -> Archives.sbd
    else
    {
      // Both Archives (dir) and Archives.sbd exist: pick one to keep
      // Move content into Archives.sbd and remove stray Archives dir
      const it = mbox.directoryEntries;
      while (it?.hasMoreElements && it.hasMoreElements()) {
        const f = it.getNext().QueryInterface(Ci.nsIFile);
        f.moveTo(sbd, f.leafName);
      }
      mbox.remove(true);
    }
  }

  // Ensure the mbox FILE exists (empty is fine), createStorageIfMissing will create the mbox + .msf
  if (!mbox.exists())
    local.createStorageIfMissing(null);

  // Make sure .sbd exists if there are/will be children
  if (!sbd.exists()) {
    try { sbd.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700); } catch (_) {}
  }

  try { nsFolder.updateFolderWithListener(null, null); } catch (_) {}
  try { void nsFolder.msgDatabase; } catch (_) {}
}

// If we load an older version of archibald archives, we need to move things a bit
function moveExistingMboxesIntoRootSbd(sourceDir, targetDir)
{
  const entries = sourceDir.directoryEntries;
  while (entries.hasMoreElements())
  {
    const f = entries.getNext().QueryInterface(Ci.nsIFile);
    const name = f.leafName;

    // Never import old DBs
    if (name.endsWith(".msf"))
      continue;
    if (name.startsWith(".") || name === targetDir.leafName)
      continue;

    try
    {
      //console.log("[Archibald] - Copying", name, "to", targetDir.path);
      // Was: f.moveTo(targetDir, name);
      f.copyTo(targetDir, name);
    }
    catch (e)
    {
      console.warn("[Archibald] - Could not copy", name, ":", e);
    }
  }
}

// Reading legacy archive and make it a tree
function scanDiskTree(dir)
{
  // dir: nsIFile directory (typically <root>.sbd or a child *.sbd)
  // returns: array of { name, children } objects
  const map = Object.create(null);

  const entries = dir.directoryEntries;
  while (entries.hasMoreElements())
  {
    const f = entries.getNext().QueryInterface(Ci.nsIFile);
    const leaf = f.leafName;

    // Ignore old DBs completely
    if (leaf.endsWith(".msf"))
      continue;

    if (f.isFile())
    {
      // Plain mbox file "Foo" -> folder "Foo" (ignore names with dots)
      if (!leaf.includes("."))
      {
        if (!map[leaf])
          map[leaf] = { name: leaf, children: [] };
      }
    }
    else if (f.isDirectory() && leaf.endsWith(".sbd"))
    {
      const base = leaf.substring(0, leaf.length - 4);
      if (!map[base])
        map[base] = { name: base, children: [] };

      map[base].children = scanDiskTree(f);
    }
  }

  return Object.values(map);
}

function debugFolderStorage(folder)
{
  try
  {
    const local = folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
    const file = local.filePath;
    console.log("[Archibald] - Storage for", folder.URI,
      "=>", file.path,
      "exists:", file.exists(),
      "size:", file.exists() ? file.fileSize : "n/a");
  }
  catch (e)
  {
    console.warn("[Archibald] - debugFolderStorage failed for", folder.URI, e);
  }
}

async function buildTbFoldersFromTree(parentTbFolder, children)
{
    // Check validity of the root folder object before starting the loop
    if (!parentTbFolder || !parentTbFolder.name)
    {
        console.error("[Archibald] - buildTbFoldersFromTree called with invalid parentTbFolder.");
        return;
    }

    for (const node of children)
    {
        // Ensure the parent is still valid after the 'await' pause.
        if (parentTbFolder.URI === null)
        {
            console.error(`[Archibald] - Parent folder became invalid (null URI) after await in node: ${node.name}. Breaking loop.`);
            return;
        }

        let tbChild;
        try
        {
            console.log("Processing under parent:", parentTbFolder.name);

            // The synchronous logic inside forceMboxLayoutFix (called by ensureSubfolder)
            // is stable, but the await still yields control.
            tbChild = await ensureSubfolder(parentTbFolder, node.name);

            // Check if ensureSubfolder failed to return a child
            if (!tbChild)
            {
                 console.warn("[Archibald] - ensureSubfolder failed to return child for", node.name);
                 continue;
            }
        }
        catch (e)
        {
            console.warn("[Archibald] - ensureSubfolder failed for", node.name, "under", parentTbFolder.name, e);
            continue;
        }

        if (node.children && node.children.length)
        {
            // Recurse into the newly created child folder
            await buildTbFoldersFromTree(tbChild, node.children);
        }
    }
}

// Determine wether a chosen local folder already contains a maildir to import or not
async function hasExistingMailStructure(dirFile)
{
  if (!dirFile.exists() || !dirFile.isDirectory())
    return false;

  const entries = dirFile.directoryEntries;
  while (entries.hasMoreElements())
  {
    const entry = entries.getNext().QueryInterface(Ci.nsIFile);
    const name  = entry.leafName;

    // Skip hidden files, just to reduce noise
    if (name.startsWith("."))
      continue;

    // Any non-.msf file is considered potential mail data (mbox, etc.)
    if (entry.isFile())
    {
      if (!name.endsWith(".msf"))
        return true;

      continue;
    }

    // Any directory suggests existing structure (.sbd, maildir, etc.)
    if (entry.isDirectory())
      return true;
  }

  return false;
}

// Handle multiple store type while exploring existing local folders
async function detectStoreType(dirFile)
{
  // Very simple heuristic:
  // - If we see maildir-like "cur/new/tmp" directories anywhere -> maildir
  // - Else -> Berkeley mbox
  let sawMaildir = false;

  const entries = dirFile.directoryEntries;
  while (entries.hasMoreElements())
  {
    const entry = entries.getNext().QueryInterface(Ci.nsIFile);
    if (!entry.isDirectory())
      continue;

    const name = entry.leafName;
    if (name === "cur" || name === "new" || name === "tmp")
    {
      sawMaildir = true;
      break;
    }
  }

  if (sawMaildir)
    return "@mozilla.org/msgstore/maildirstore;1";

  return "@mozilla.org/msgstore/berkeleystore;1";
}

// Finds a subfolder of rootFolder by name, ignoring case (so it matches both Inbox and inbox, etc.).
function getChildIgnoreCase(rootFolder, name)
{
  const wanted = name.toLowerCase();
  const children = rootFolder.subFolders || [];

  for (const folder of children)
  {
    if (folder.name.toLowerCase() === wanted)
      return folder;
  }
  return null;
}

// Goes through the account’s top-level folders and assigns special flags (Inbox, Trash, Sent, etc.)
async function autoFlagSpecialFolders(root)
{
  const SPECIALS = [
    { name: "Inbox",           flag: F.Inbox },
    { name: "Trash",           flag: F.Trash },
    { name: "Sent",            flag: F.SentMail },
    { name: "Sent Items",      flag: F.SentMail },
    { name: "Drafts",          flag: F.Drafts },
    { name: "Templates",       flag: F.Templates },
    { name: "Archives",        flag: F.Archive },
    { name: "Junk",            flag: F.Junk },
    { name: "Unsent Messages", flag: F.Queue },
  ];

  for (const { name, flag } of SPECIALS)
  {
    const folder = getChildIgnoreCase(root, name);
    if (!folder)
      continue;

    try
    {
      if (typeof folder.setFlag === "function")
        folder.setFlag(flag);
      else
        folder.flags |= flag;
    }
    catch (e)
    {
      console.warn("Failed to set flag", flag, "on", name, e);
    }
  }
}
// Injection d'une feuille de style spécifique pour synchroniser les icônes de la barre d'espaces
// avec le mode d'affichage réel (clair / sombre) de Thunderbird, indépendamment du prefers-color-scheme OS.
function injectThemeOverrideStyle(w) {
  try {
    if (!w || !w.document) return;
    const STYLE_ID = "webapp-spaces-theme-override";
    if (!w.document.getElementById(STYLE_ID)) {
      const styleEl = w.document.createElementNS("http://www.w3.org/1999/xhtml", "style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = `
        /* 1. PAR DÉFAUT (thème clair) : toujours afficher l'icône sombre pour éviter clair sur clair */
        .spaces-addon-button img,
        .spaces-addon-menuitem {
          content: var(--webextension-toolbar-image-dark, inherit) !important;
          --menuitem-icon: var(--webextension-toolbar-image-dark, inherit) !important;
        }

        /* 2. THÈME SOMBRE : basculer sur l'icône claire */
        :root[lwtheme-brighttext] .spaces-addon-button img,
        :root[lwt-tree-brighttext] .spaces-addon-button img,
        :root[data-spaces-theme-mode="dark"] .spaces-addon-button img,
        #spacesToolbar[data-theme-mode="dark"] .spaces-addon-button img,
        :root[lwtheme-brighttext] .spaces-addon-menuitem,
        :root[lwt-tree-brighttext] .spaces-addon-menuitem,
        :root[data-spaces-theme-mode="dark"] .spaces-addon-menuitem,
        #spacesToolbar[data-theme-mode="dark"] .spaces-addon-menuitem {
          content: var(--webextension-toolbar-image-light, inherit) !important;
          --menuitem-icon: var(--webextension-toolbar-image-light, inherit) !important;
        }

        /* 3. THÈME CLAIR EXPLICITE */
        :root[data-spaces-theme-mode="light"] .spaces-addon-button img,
        #spacesToolbar[data-theme-mode="light"] .spaces-addon-button img,
        :root[data-spaces-theme-mode="light"] .spaces-addon-menuitem,
        #spacesToolbar[data-theme-mode="light"] .spaces-addon-menuitem {
          content: var(--webextension-toolbar-image-dark, inherit) !important;
          --menuitem-icon: var(--webextension-toolbar-image-dark, inherit) !important;
        }

        /* 4. MODE SOMBRE SYSTÈME (OS) si Thunderbird n'impose pas un thème clair */
        @media (prefers-color-scheme: dark) {
          :root:not([lwtheme]) .spaces-addon-button img,
          :root[lwtheme-brighttext] .spaces-addon-button img,
          :root:not([lwtheme]) .spaces-addon-menuitem,
          :root[lwtheme-brighttext] .spaces-addon-menuitem {
            content: var(--webextension-toolbar-image-light, inherit) !important;
            --menuitem-icon: var(--webextension-toolbar-image-light, inherit) !important;
          }
        }
      `;
      (w.document.head || w.document.documentElement).appendChild(styleEl);
      console.log("[Archibald] Style de détection de thème injecté avec succès");
    }
  } catch (e) {
    console.error("[Archibald] Erreur injection style de thème:", e);
  }
}

function setupSpacesToolbarObserver(w) {
  try {
    if (!w || !w.document) return;
    injectThemeOverrideStyle(w);

    const toolbar = w.document.getElementById("spacesToolbar");
    if (!toolbar) {
      w.setTimeout(() => setupSpacesToolbarObserver(w), 250);
      return;
    }

    // Déconnecter l'ancien observateur s'il existe pour éviter les conflits
    if (w._archibald_spaces_observer) {
      try {
        w._archibald_spaces_observer.disconnect();
      } catch (e) { }
      w._archibald_spaces_observer = null;
    }

    const updateToolbarTheme = () => {
      try {
        let isDark = false;

        // 1. Détection par colorScheme Gecko/CSS sur la barre d'espaces ou la racine
        const tbCs = w.getComputedStyle(toolbar)?.colorScheme;
        const rootCs = w.getComputedStyle(w.document.documentElement)?.colorScheme;
        if (tbCs === "dark" || rootCs === "dark") {
          isDark = true;
        } else if (tbCs === "light" || rootCs === "light") {
          isDark = false;
        } else {
          // 2. Détection par la luminosité de la couleur de texte / icône native de la SpacesToolbar
          const sampleBtn = toolbar.querySelector(".spaces-toolbar-button") || toolbar.querySelector("button");
          const sampleEl = sampleBtn || toolbar;
          const computedColor = w.getComputedStyle(sampleEl)?.color || "";
          const rgbMatch = computedColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (rgbMatch) {
            const r = parseInt(rgbMatch[1], 10);
            const g = parseInt(rgbMatch[2], 10);
            const b = parseInt(rgbMatch[3], 10);
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            isDark = brightness > 128;
          } else {
            // 3. Fallback sur le media query standard prefers-color-scheme
            isDark = w.matchMedia?.("(prefers-color-scheme: dark)")?.matches || false;
          }
        }

        const mode = isDark ? "dark" : "light";
        if (toolbar.getAttribute("data-theme-mode") !== mode) {
          toolbar.setAttribute("data-theme-mode", mode);
          w.document.documentElement?.setAttribute("data-spaces-theme-mode", mode);
          console.log(`[Archibald] Thème spacesToolbar détecté: ${mode}`);
        }
      } catch (e) {
        console.error("[Archibald] Erreur détection thème:", e);
      }
    };

    // Écouter les changements de thème dynamique
    if (w._archibald_theme_listener) {
      try {
        w.removeEventListener("windowlwthemeupdate", w._archibald_theme_listener);
      } catch (e) { }
      w._archibald_theme_listener = null;
    }
    w._archibald_theme_listener = updateToolbarTheme;
    w.addEventListener("windowlwthemeupdate", updateToolbarTheme);

    if (w._archibald_media_listener && w._archibald_mql?.removeEventListener) {
      try {
        w._archibald_mql.removeEventListener("change", w._archibald_media_listener);
      } catch (e) { }
    }
    try {
      const mql = w.matchMedia("(prefers-color-scheme: dark)");
      if (mql?.addEventListener) {
        w._archibald_mql = mql;
        w._archibald_media_listener = updateToolbarTheme;
        mql.addEventListener("change", updateToolbarTheme);
      }
    } catch (e) { }

    updateToolbarTheme();
    w.setTimeout(updateToolbarTheme, 150);
    w.setTimeout(updateToolbarTheme, 500);
    w.setTimeout(updateToolbarTheme, 1200);
    w.setTimeout(updateToolbarTheme, 3000);
    w.setTimeout(updateToolbarTheme, 6000);
  } catch (err) {
    console.error("[Archibald] Erreur dans setupSpacesToolbarObserver:", err);
  }
}

// ================================= GESTION AFFICHAGE BALP (about:3pane) ============================================
const CM2_BOITE_PARTAGEE = "Boite partagée";
const CM2_BOITE_PARTAGEE_MUTF7 = "Boite partag&AOk-e";
const CM2_COURRIER_ENTRANT = "Courrier entrant";

function decodeImapFolderLabel(str) {
  if (!str || typeof str !== "string") return "";
  try {
    str = decodeURIComponent(str);
  } catch (_) {
    str = str.replace(/%20/g, " ");
  }
  return str.replace(/&([^-]*)-/g, (match, b64) => {
    if (b64 === "") return "&";
    try {
      let base64 = b64.replace(/,/g, "/");
      while (base64.length % 4 !== 0) base64 += "=";
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder("utf-16be").decode(bytes);
    } catch (_) {
      return match;
    }
  });
}

function cm2IsDossierBoitePartage(folder) {
  if (!folder) return false;
  const name = folder.name || "";
  if (name === CM2_BOITE_PARTAGEE || name === CM2_BOITE_PARTAGEE_MUTF7) return true;
  if (decodeImapFolderLabel(name) === CM2_BOITE_PARTAGEE) return true;
  return false;
}

function cm2IsServerBalp(server) {
  if (!server) return false;
  try {
    if (server.username && server.username.includes(".-.")) return true;
  } catch (_) {}
  try {
    if (typeof server.getStringValue === "function" && server.getStringValue("pacome.confid") === "par1") {
      return true;
    }
  } catch (_) {}
  try {
    const subs = server.rootFolder?.subFolders || [];
    for (const f of subs) {
      if (cm2IsDossierBoitePartage(f)) return true;
    }
  } catch (_) {}
  return false;
}

function cm2IsFolderBalp(folder) {
  try {
    return !!(folder && folder.server && cm2IsServerBalp(folder.server));
  } catch (_) {
    return false;
  }
}

function cm2IsEntrantBalp(folder) {
  try {
    return !!(
      folder &&
      cm2IsFolderBalp(folder) &&
      folder.parent &&
      cm2IsDossierBoitePartage(folder.parent)
    );
  } catch (_) {
    return false;
  }
}

function cm2EnsureBalpSubfolderFlags(subFolder) {
  if (!subFolder) return;
  const decodedName = decodeImapFolderLabel(subFolder.name || "").trim();
  let flagToSet = 0;
  switch (decodedName) {
    case "Corbeille":
    case "Trash":
      flagToSet = F.Trash;
      break;
    case "Brouillons":
    case "Drafts":
      flagToSet = F.Drafts;
      break;
    case "Éléments envoyés":
    case "Elements envoyés":
    case "Sent":
    case "Sent Items":
      flagToSet = F.SentMail;
      break;
    case "Modèles":
    case "Modeles":
    case "Templates":
      flagToSet = F.Templates;
      break;
    case "Indésirables":
    case "Indesirables":
    case "Junk":
      flagToSet = F.Junk;
      break;
    case "Archives":
      flagToSet = F.Archive;
      break;
  }
  if (flagToSet && !(subFolder.flags & flagToSet)) {
    try {
      if (typeof subFolder.setFlag === "function") {
        subFolder.setFlag(flagToSet);
      } else {
        subFolder.flags |= flagToSet;
      }
    } catch (_) {}
  }
}

function cm2UpdateRowDepthRecursively(row, depth) {
  if (!row) return;
  try {
    row.depth = depth;
    if (row.childList) {
      row.childList.style.setProperty("--depth", depth);
      for (const child of row.childList.children) {
        if (child && child.tagName === "LI") {
          cm2UpdateRowDepthRecursively(child, depth + 1);
        }
      }
    }
  } catch (_) {}
}

function cm2HideRowAndDescendants(row) {
  if (!row) return false;
  let changed = false;
  if (row.style.display !== "none") {
    row.style.display = "none";
    changed = true;
  }
  if (!row.classList.contains("unselectable") || !row.classList.contains("collapsed")) {
    row.classList.add("unselectable", "collapsed");
    changed = true;
  }
  for (const desc of row.querySelectorAll("li")) {
    if (desc.style.display !== "none") {
      desc.style.display = "none";
      changed = true;
    }
    desc.classList.add("unselectable", "collapsed");
  }
  return changed;
}

function reparentSharedMailboxesCM2(about3PaneWin) {
  try {
    if (!about3PaneWin || about3PaneWin.closed) return;
    const { folderPane, folderTree } = about3PaneWin;
    if (!folderPane || !folderTree || !folderPane._modes?.all?.active) return;

    let domModified = false;

    for (const account of MailServices.accounts.accounts) {
      const server = account?.incomingServer;
      if (!server || server.hidden || !cm2IsServerBalp(server)) continue;

      const rootFolder = server.rootFolder;
      if (!rootFolder) continue;

      const serverRow = folderPane.getRowForFolder(rootFolder, "all");
      if (!serverRow || !serverRow.childList) continue;

      const rootSubFolders = [...(rootFolder.subFolders || [])];

      // 1. Trouver les dossiers conteneurs "Boite partagée" / "Boite partag&AOk-e"
      const bpFolders = rootSubFolders.filter(f => cm2IsDossierBoitePartage(f));
      if (bpFolders.length === 0) continue;

      // Prioriser le vrai dossier "Boite partagée" (UTF-8) par rapport au dossier fantôme MUTF-7 "Boite partag&AOk-e"
      bpFolders.sort((a, b) => {
        const aExact = a.name === CM2_BOITE_PARTAGEE ? 0 : 1;
        const bExact = b.name === CM2_BOITE_PARTAGEE ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aSubs = (a.subFolders || []).length;
        const bSubs = (b.subFolders || []).length;
        return bSubs - aSubs;
      });

      // 2. Identifier le dossier BALP Entrant principal et les éventuels doublons fantômes
      let primaryEntrant = null;
      const secondaryEntrants = [];

      for (const bpFolder of bpFolders) {
        const children = [...(bpFolder.subFolders || [])];
        for (const child of children) {
          if (!cm2IsEntrantBalp(child)) continue;
          if (!primaryEntrant) {
            primaryEntrant = child;
          } else {
            secondaryEntrants.push(child);
          }
        }
      }

      if (!primaryEntrant) continue;

      // 3. Configurer le dossier BALP Entrant principal en tant que "Courrier entrant" (Inbox)
      try {
        if (!(primaryEntrant.flags & F.Inbox)) {
          if (typeof primaryEntrant.setFlag === "function") {
            primaryEntrant.setFlag(F.Inbox);
          } else {
            primaryEntrant.flags |= F.Inbox;
          }
        }
      } catch (_) {}

      const anchorRow = folderPane.getRowForFolder(primaryEntrant, "all");
      if (!anchorRow) continue;

      // Surcharger updateFolderNames et setFolderTypeFromFolder sur anchorRow pour conserver le libellé "Courrier entrant" et l'icône Inbox
      if (!anchorRow._archibaldBalpInboxWrapped) {
        if (typeof anchorRow.updateFolderNames === "function") {
          const origUpdateFolderNames = anchorRow.updateFolderNames.bind(anchorRow);
          anchorRow.updateFolderNames = function(folder) {
            try { origUpdateFolderNames(folder); } catch (_) {}
            this._folderName = CM2_COURRIER_ENTRANT;
            this._fullFolderName = CM2_COURRIER_ENTRANT;
            this.dataset.folderType = "inbox";
            if (typeof this._setName === "function") {
              this._setName();
            } else {
              this.name = CM2_COURRIER_ENTRANT;
            }
          };
        }
        if (typeof anchorRow.setFolderTypeFromFolder === "function") {
          const origSetFolderType = anchorRow.setFolderTypeFromFolder.bind(anchorRow);
          anchorRow.setFolderTypeFromFolder = function(folder) {
            try { origSetFolderType(folder); } catch (_) {}
            this.dataset.folderType = "inbox";
          };
        }
        anchorRow._archibaldBalpInboxWrapped = true;
      }

      if (anchorRow.style.display === "none") {
        anchorRow.style.display = "";
        domModified = true;
      }
      anchorRow.classList.remove("unselectable");
      anchorRow.dataset.folderType = "inbox";
      anchorRow._folderName = CM2_COURRIER_ENTRANT;
      anchorRow._fullFolderName = CM2_COURRIER_ENTRANT;
      if (typeof anchorRow._setName === "function") {
        anchorRow._setName();
      } else {
        anchorRow.name = CM2_COURRIER_ENTRANT;
      }

      // Placer "Courrier entrant" (anchorRow) en tête des dossiers du serveur
      if (
        anchorRow.parentElement !== serverRow.childList ||
        serverRow.childList.firstElementChild !== anchorRow
      ) {
        serverRow.childList.insertBefore(anchorRow, serverRow.childList.firstElementChild);
        domModified = true;
      }

      // 4. Collecter les sous-dossiers de primaryEntrant (et ceux non-dupliqués des secondaryEntrants)
      const subFoldersToPromote = [...(primaryEntrant.subFolders || [])];
      const seenDecodedNames = new Set(
        subFoldersToPromote.map(f => decodeImapFolderLabel(f.name || "").toLowerCase())
      );

      for (const secEntrant of secondaryEntrants) {
        for (const secSub of (secEntrant.subFolders || [])) {
          const decodedSecName = decodeImapFolderLabel(secSub.name || "").toLowerCase();
          if (!seenDecodedNames.has(decodedSecName)) {
            seenDecodedNames.add(decodedSecName);
            subFoldersToPromote.push(secSub);
          }
        }
      }

      // Assigner les flags spéciaux (Corbeille, Brouillons, Éléments envoyés, Modèles, Indésirables, Archives) avant le tri
      for (const subFolder of subFoldersToPromote) {
        cm2EnsureBalpSubfolderFlags(subFolder);
      }

      subFoldersToPromote.sort(FolderUtils.compareFolders);

      // 5. Remonter tous les sous-dossiers directement sous serverRow.childList, juste après anchorRow
      const baseDepth = (serverRow.depth || 1) + 1;
      cm2UpdateRowDepthRecursively(anchorRow, baseDepth);

      let prevRow = anchorRow;
      for (const childFolder of subFoldersToPromote) {
        const childRow = folderPane.getRowForFolder(childFolder, "all");
        if (!childRow) continue;

        if (childRow.style.display === "none") {
          childRow.style.display = "";
          domModified = true;
        }
        childRow.classList.remove("unselectable");
        if (typeof childRow.setFolderTypeFromFolder === "function") {
          childRow.setFolderTypeFromFolder(childFolder);
        }

        if (
          childRow.parentElement !== serverRow.childList ||
          prevRow.nextElementSibling !== childRow
        ) {
          serverRow.childList.insertBefore(childRow, prevRow.nextElementSibling);
          domModified = true;
        }
        cm2UpdateRowDepthRecursively(childRow, baseDepth);
        prevRow = childRow;
      }

      // 6. Masquer les conteneurs "Boite partagée" / "Boite partag&AOk-e" et leurs éventuels enfants restants (fantômes)
      for (const bpFolder of bpFolders) {
        const bpRow = folderPane.getRowForFolder(bpFolder, "all");
        if (bpRow && cm2HideRowAndDescendants(bpRow)) {
          domModified = true;
        }
      }

      // 7. Nettoyer l'état de anchorRow (qui est maintenant une feuille sans sous-dossiers dans l'arbre)
      if (anchorRow.classList.contains("children") || anchorRow.classList.contains("collapsed")) {
        anchorRow.classList.remove("children", "collapsed");
        anchorRow.removeAttribute("aria-expanded");
        domModified = true;
      }
      try {
        if (typeof anchorRow.updateUnreadMessageCount === "function") {
          anchorRow.updateUnreadMessageCount();
        }
        if (typeof anchorRow.updateTotalMessageCount === "function") {
          anchorRow.updateTotalMessageCount();
        }
        if (typeof anchorRow.updateNewMessages === "function") {
          anchorRow.updateNewMessages();
        }
      } catch (_) {}

      // 8. Masquer le dossier INBOX racine inutilisé du compte BALP
      const unusedInboxFolder = rootSubFolders.find(
        f =>
          f !== primaryEntrant &&
          !cm2IsDossierBoitePartage(f) &&
          (f.name.toUpperCase() === "INBOX" ||
           f.localizedName === CM2_COURRIER_ENTRANT ||
           Boolean(f.flags & F.Inbox))
      );
      if (unusedInboxFolder) {
        const inboxRow = folderPane.getRowForFolder(unusedInboxFolder, "all");
        if (inboxRow && inboxRow !== anchorRow) {
          const wasSelected = folderTree.selectedRow === inboxRow;
          if (cm2HideRowAndDescendants(inboxRow)) {
            domModified = true;
          }
          if (wasSelected) {
            try {
              if (typeof about3PaneWin.displayFolder === "function") {
                about3PaneWin.displayFolder(primaryEntrant.URI);
              } else {
                folderTree.selectedRow = anchorRow;
              }
            } catch (_) {}
          }
        }
      }

      // S'assurer que la liste d'enfants du serveur est visible s'il n'est pas replié
      if (!serverRow.classList.contains("collapsed") && serverRow.childList) {
        serverRow.childList.hidden = false;
        serverRow.childList.style.height = "";
      }
    }

    if (domModified) {
      try {
        if (typeof folderTree.domChanged === "function") {
          folderTree.domChanged();
        }
        if (typeof folderTree._initRows === "function") {
          folderTree._initRows();
        }
      } catch (_) {}
    }

    // Mettre à jour l'en-tête de la liste de messages si le dossier BALP entrant est sélectionné
    try {
      if (about3PaneWin.gFolder && cm2IsEntrantBalp(about3PaneWin.gFolder)) {
        if (about3PaneWin.threadPaneHeader?.folderName) {
          about3PaneWin.threadPaneHeader.folderName.textContent = CM2_COURRIER_ENTRANT;
        }
        about3PaneWin.document.title = `${CM2_COURRIER_ENTRANT} - ${about3PaneWin.gFolder.server.prettyName}`;
      }
    } catch (_) {}
  } catch (e) {
    console.error("[Archibald] Erreur dans reparentSharedMailboxesCM2:", e);
  }
}

function scheduleReparent(about3PaneWin, delay = 0) {
  if (!about3PaneWin || about3PaneWin.closed) return;
  if (delay <= 0) {
    reparentSharedMailboxesCM2(about3PaneWin);
    return;
  }
  about3PaneWin.setTimeout(() => {
    if (!about3PaneWin.closed) {
      reparentSharedMailboxesCM2(about3PaneWin);
    }
  }, delay);
}

function setupAbout3PaneBalpHooks(about3PaneWin) {
  try {
    if (!about3PaneWin || about3PaneWin.closed) return;
    const href = about3PaneWin.location?.href || "";
    if (!href.startsWith("about:3pane")) return;

    const { folderPane, folderTree } = about3PaneWin;
    if (!folderPane || !folderTree || !folderPane._initialized) {
      about3PaneWin.setTimeout(() => setupAbout3PaneBalpHooks(about3PaneWin), 150);
      return;
    }

    if (!about3PaneWin._archibald_balp_hooks_installed) {
      about3PaneWin._archibald_balp_hooks_installed = true;

      // 1. Intercepter folderPane._modes.all.initServer
      if (folderPane._modes?.all && typeof folderPane._modes.all.initServer === "function") {
        const allMode = folderPane._modes.all;
        allMode._archibald_orig_initServer = allMode.initServer;
        allMode.initServer = function(server) {
          const res = allMode._archibald_orig_initServer.apply(this, arguments);
          try {
            reparentSharedMailboxesCM2(about3PaneWin);
          } catch (_) {}
          return res;
        };
      }

      // 2. Intercepter folderPane.addFolder
      if (typeof folderPane.addFolder === "function") {
        folderPane._archibald_orig_addFolder = folderPane.addFolder;
        folderPane.addFolder = function(parentFolder, childFolder) {
          const res = folderPane._archibald_orig_addFolder.apply(this, arguments);
          try {
            if (
              (parentFolder && cm2IsFolderBalp(parentFolder)) ||
              (childFolder && cm2IsFolderBalp(childFolder))
            ) {
              reparentSharedMailboxesCM2(about3PaneWin);
              scheduleReparent(about3PaneWin, 50);
            }
          } catch (_) {}
          return res;
        };
      }

      // 3. Intercepter folderPane.changeFolderFlag
      if (typeof folderPane.changeFolderFlag === "function") {
        folderPane._archibald_orig_changeFolderFlag = folderPane.changeFolderFlag;
        folderPane.changeFolderFlag = function(folder, oldValue, newValue) {
          const res = folderPane._archibald_orig_changeFolderFlag.apply(this, arguments);
          try {
            if (folder && cm2IsFolderBalp(folder)) {
              reparentSharedMailboxesCM2(about3PaneWin);
            }
          } catch (_) {}
          return res;
        };
      }

      // 4. Intercepter threadPaneHeader.onFolderSelected
      if (about3PaneWin.threadPaneHeader && typeof about3PaneWin.threadPaneHeader.onFolderSelected === "function") {
        const tph = about3PaneWin.threadPaneHeader;
        tph._archibald_orig_onFolderSelected = tph.onFolderSelected;
        tph.onFolderSelected = function() {
          const res = tph._archibald_orig_onFolderSelected.apply(this, arguments);
          try {
            if (about3PaneWin.gFolder && cm2IsEntrantBalp(about3PaneWin.gFolder)) {
              if (this.folderName) {
                this.folderName.textContent = CM2_COURRIER_ENTRANT;
              }
              about3PaneWin.document.title = `${CM2_COURRIER_ENTRANT} - ${about3PaneWin.gFolder.server.prettyName}`;
            }
          } catch (_) {}
          return res;
        };
      }

      console.log("[Archibald] Hooks BALP installés sur about:3pane");
    }

    reparentSharedMailboxesCM2(about3PaneWin);
    scheduleReparent(about3PaneWin, 150);
    scheduleReparent(about3PaneWin, 500);
    scheduleReparent(about3PaneWin, 1500);
    scheduleReparent(about3PaneWin, 3500);
  } catch (e) {
    console.error("[Archibald] Erreur dans setupAbout3PaneBalpHooks:", e);
  }
}

function getAbout3PaneWindowsFromTopWindow(w) {
  const result = new Set();
  if (!w || w.closed) return result;
  try {
    if (w.location?.href?.startsWith("about:3pane")) {
      result.add(w);
      return result;
    }
  } catch (_) {}

  try {
    if (w.gTabmail?.tabInfo) {
      for (const tab of w.gTabmail.tabInfo) {
        const cw = tab?.chromeBrowser?.contentWindow || tab?.browser?.contentWindow;
        if (cw && !cw.closed && cw.location?.href?.startsWith("about:3pane")) {
          result.add(cw);
        }
      }
    }
  } catch (_) {}

  try {
    const browsers = w.document?.querySelectorAll("browser") || [];
    for (const b of browsers) {
      const cw = b?.contentWindow;
      if (cw && !cw.closed && cw.location?.href?.startsWith("about:3pane")) {
        result.add(cw);
      }
    }
  } catch (_) {}

  return result;
}

function cleanupAbout3PaneBalpHooks(about3PaneWin) {
  try {
    if (!about3PaneWin || !about3PaneWin._archibald_balp_hooks_installed) return;
    const { folderPane, threadPaneHeader } = about3PaneWin;
    if (folderPane) {
      if (folderPane._modes?.all?._archibald_orig_initServer) {
        folderPane._modes.all.initServer = folderPane._modes.all._archibald_orig_initServer;
        delete folderPane._modes.all._archibald_orig_initServer;
      }
      if (folderPane._archibald_orig_addFolder) {
        folderPane.addFolder = folderPane._archibald_orig_addFolder;
        delete folderPane._archibald_orig_addFolder;
      }
      if (folderPane._archibald_orig_changeFolderFlag) {
        folderPane.changeFolderFlag = folderPane._archibald_orig_changeFolderFlag;
        delete folderPane._archibald_orig_changeFolderFlag;
      }
    }
    if (threadPaneHeader?._archibald_orig_onFolderSelected) {
      threadPaneHeader.onFolderSelected = threadPaneHeader._archibald_orig_onFolderSelected;
      delete threadPaneHeader._archibald_orig_onFolderSelected;
    }
    about3PaneWin._archibald_balp_hooks_installed = false;
  } catch (_) {}
}
// ================================= FIN HELPERS ============================================

let _archibaldGlobalListenersRegistered = false;

this.archibaldApi = class extends ExtensionAPI {
  getAPI(context) {
    console.log("Archibald implementation loaded.");

    // Event bridge
    const onArchiveEvent = new ExtensionCommon.EventManager({
      context,
      name: "archibaldApi.onArchive",
      register: (fire) => {
        const listener = (eventName, messages) => {
          console.log("Archibald received TbArchive in implementation from Thunderbird core:", messages);
          fire.async(messages);
        };
        this.extension.on("TbArchive", listener);
        return () => this.extension.off("TbArchive", listener);
      },
    }).api();

    return {
      archibaldApi: {
        init() {
          try {
            function initSingleWindow(w) {
              if (!w || w.closed) return;
              const href = w.location?.href || "";

              if (href.startsWith("about:3pane")) {
                setupAbout3PaneBalpHooks(w);
                return;
              }

              if (!w._archibald_window_init_done) {
                w._archibald_window_init_done = true;
                injectThemeOverrideStyle(w);
                setupSpacesToolbarObserver(w);
              }

              // Initialiser également toutes les sous-fenêtres about:3pane contenues dans ce messenger.xhtml
              const about3PaneWins = getAbout3PaneWindowsFromTopWindow(w);
              for (const a3pWin of about3PaneWins) {
                setupAbout3PaneBalpHooks(a3pWin);
              }
              w.setTimeout(() => {
                for (const a3pWin of getAbout3PaneWindowsFromTopWindow(w)) {
                  setupAbout3PaneBalpHooks(a3pWin);
                }
              }, 300);
            }

            // Initialiser les fenêtres déjà ouvertes
            const enumerator = WM.getEnumerator("mail:3pane");
            let winCount = 0;
            while (enumerator.hasMoreElements()) {
              const win = enumerator.getNext();
              initSingleWindow(win);
              winCount++;
            }

            if (_archibaldGlobalListenersRegistered) {
              return;
            }
            _archibaldGlobalListenersRegistered = true;
            console.log(`[Archibald] init: ${winCount} fenêtre(s) mail:3pane initialisée(s) au démarrage`);

            // Écouter les fenêtres futures via window-mediator
            const winListener = {
              onOpenWindow(xulWin) {
                try {
                  const domWin = xulWin.docShell?.domWindow;
                  if (domWin) {
                    domWin.addEventListener(
                      "DOMContentLoaded",
                      () => {
                        try {
                          const href = domWin.location?.href || "";
                          const winType = domWin.document?.documentElement?.getAttribute("windowtype") || "";
                          if (winType === "mail:3pane" || href.includes("messenger.xhtml") || href.includes("3pane")) {
                            domWin.setTimeout(() => initSingleWindow(domWin), 50);
                          }
                        } catch (e) {}
                      },
                      { once: true }
                    );
                  }
                } catch (e) {}
              },
              onCloseWindow() {},
              onWindowTitleChange() {},
            };
            WM.addListener(winListener);

            // Observer les futurs chargements de documents chrome via observer service
            const obsService = globalThis.Services?.obs || (Cc["@mozilla.org/observer-service;1"] ? Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService) : null);
            let docObserver = null;
            if (obsService) {
              docObserver = {
                observe(subject, topic, data) {
                  try {
                    const doc = subject;
                    const w = doc?.defaultView;
                    if (!w) return;
                    const href = w.location?.href || "";
                    if (href.includes("messenger.xhtml") || href.includes("3pane")) {
                      w.setTimeout(() => initSingleWindow(w), 50);
                    }
                  } catch (e) {}
                }
              };
              obsService.addObserver(docObserver, "chrome-document-loaded");
            }

            // Écouter les ajouts dynamiques de dossiers IMAP pour réorganiser les BALP à la volée
            const balpFolderListener = {
              onFolderAdded(parentFolder, childFolder) {
                try {
                  if (
                    (parentFolder && cm2IsFolderBalp(parentFolder)) ||
                    (childFolder && cm2IsFolderBalp(childFolder))
                  ) {
                    const winEnum = WM.getEnumerator("mail:3pane");
                    while (winEnum.hasMoreElements()) {
                      const topWin = winEnum.getNext();
                      for (const a3pWin of getAbout3PaneWindowsFromTopWindow(topWin)) {
                        scheduleReparent(a3pWin, 20);
                        scheduleReparent(a3pWin, 200);
                      }
                    }
                  }
                } catch (_) {}
              },
              onMessageAdded() {},
              onFolderRemoved() {},
              onMessageRemoved() {},
              onFolderPropertyChanged() {},
              onFolderIntPropertyChanged(folder, property, oldValue, newValue) {
                try {
                  if (folder && cm2IsFolderBalp(folder) && String(property) === "FolderFlag") {
                    const winEnum = WM.getEnumerator("mail:3pane");
                    while (winEnum.hasMoreElements()) {
                      const topWin = winEnum.getNext();
                      for (const a3pWin of getAbout3PaneWindowsFromTopWindow(topWin)) {
                        scheduleReparent(a3pWin, 20);
                      }
                    }
                  }
                } catch (_) {}
              },
              onFolderBoolPropertyChanged() {},
              onFolderUnicharPropertyChanged() {},
              onFolderPropertyFlagChanged() {},
              onFolderEvent() {},
            };
            try {
              MailServices.mailSession.AddFolderListener(
                balpFolderListener,
                Ci.nsIFolderListener.added | Ci.nsIFolderListener.intPropertyChanged
              );
            } catch (_) {}

            context.callOnClose({
              close() {
                _archibaldGlobalListenersRegistered = false;
                try {
                  WM.removeListener(winListener);
                } catch (e) {}
                try {
                  if (obsService && docObserver) {
                    obsService.removeObserver(docObserver, "chrome-document-loaded");
                  }
                } catch (e) {}
                try {
                  MailServices.mailSession.RemoveFolderListener(balpFolderListener);
                } catch (e) {}
                try {
                  const enumerator = WM.getEnumerator("mail:3pane");
                  while (enumerator.hasMoreElements()) {
                    const w = enumerator.getNext();
                    if (w._archibald_theme_listener) {
                      w.removeEventListener("windowlwthemeupdate", w._archibald_theme_listener);
                      w._archibald_theme_listener = null;
                    }
                    if (w._archibald_media_listener && w._archibald_mql?.removeEventListener) {
                      w._archibald_mql.removeEventListener("change", w._archibald_media_listener);
                      w._archibald_media_listener = null;
                    }
                    w._archibald_window_init_done = false;
                    for (const a3pWin of getAbout3PaneWindowsFromTopWindow(w)) {
                      cleanupAbout3PaneBalpHooks(a3pWin);
                    }
                  }
                } catch (e) {}
              }
            });
          } catch (e) {
            console.error("[Archibald] init: ERREUR: " + e + "\n" + e?.stack);
          }
        },

        // ---------------------- PICK A PATH -------------------------
        async showFilePicker(options = {})
        {
          const win = getTopChromeWindow();
          if (!win) return [];

          // Create picker
          const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);

          // Mode
          let mode = Ci.nsIFilePicker.modeOpen;
          switch (options.mode) {
            case "openMultiple": mode = Ci.nsIFilePicker.modeOpenMultiple; break;
            case "save":         mode = Ci.nsIFilePicker.modeSave;         break;
            case "openFolder":   mode = Ci.nsIFilePicker.modeGetFolder;    break;
          }

          // Init
          initPickerWithParent(picker, win, options.title || "Select", mode);

          // Optional start directory
          if (options.startDir)
          {
            try
            {
              const start = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
              start.initWithPath(options.startDir);
              picker.displayDirectory = start;
            }
            catch (e)
            {
              console.warn("[archibaldApi.showFilePicker] startDir failed:", e);
            }
          }

          // Optional filters: [{ name, extensions: ["pdf","txt"] }]
          if (Array.isArray(options.filters))
          {
            try
            {
              for (const f of options.filters)
              {
                if (f?.name && Array.isArray(f.extensions))
                {
                  const pat = f.extensions.map(ext => "*." + ext).join(";");
                  picker.appendFilter(String(f.name), pat);
                }
              }
            }
            catch (e)
            {
              console.warn("[archibaldApi.showFilePicker] filters failed:", e);
            }
          }

          // Open and return paths
          return await new Promise((resolve) => {
            try
            {
              picker.open((rv) => {
                const ok = (rv === Ci.nsIFilePicker.returnOK || rv === Ci.nsIFilePicker.returnReplace);
                if (!ok)
                  return resolve([]);

                if (mode === Ci.nsIFilePicker.modeOpenMultiple)
                {
                  const out = [];
                  const it = picker.files;
                  while (it && it.hasMoreElements())
                  {
                    const f = it.getNext().QueryInterface(Ci.nsIFile);
                    if (f?.path)
                      out.push(f.path);
                  }
                  return resolve(out);
                }

                const path = picker.file?.path || "";
                resolve(path ? [path] : []);
              });
            }
            catch (e)
            {
              console.error("[archibaldApi.showFilePicker] picker.open threw:", e);
              resolve([]);
            }
          });
        },
        // ---------------------- PICK A PATH (fin) -------------------------

        // ---------------------- CHECK LOCAL FOLDER CONFLICT -------------------------
        async checkLocalFolderConflict(path)
        {
          if (!path || typeof path !== "string") {
            return { isConflict: false };
          }

          function normalizePath(p) {
            if (!p) return "";
            return p.replace(/[\\/]+$/, "").toLowerCase();
          }

          const target = normalizePath(path);

          // 1. Check default local folders server
          try {
            const defaultLocalServer = MailServices.accounts.localFoldersServer;
            if (defaultLocalServer && defaultLocalServer.localPath) {
              if (normalizePath(defaultLocalServer.localPath.path) === target) {
                return {
                  isConflict: true,
                  isDefaultLocal: true,
                  accountName: defaultLocalServer.prettyName || "Dossiers locaux"
                };
              }
            }
          } catch (e) {
            console.warn("[Archibald] Error checking localFoldersServer:", e);
          }

          // 2. Check all accounts in Thunderbird
          try {
            for (const acc of MailServices.accounts.accounts) {
              const srv = acc.incomingServer;
              if (srv && srv.localPath) {
                if (normalizePath(srv.localPath.path) === target) {
                  const isDefault = (srv.type === "none" && (srv.prettyName === "Dossiers locaux" || srv.key === "server1"));
                  return {
                    isConflict: true,
                    isDefaultLocal: isDefault,
                    accountName: srv.prettyName || (acc.defaultIdentity ? acc.defaultIdentity.email : acc.key)
                  };
                }
              }
            }
          } catch (e) {
            console.warn("[Archibald] Error checking accounts for path conflict:", e);
          }

          return { isConflict: false };
        },

        // ---------------------- CREATE / IMPORT LOCAL ACCOUNT -------------------------
        async createCustomLocalFolder(accountId, path)
        {
            console.log("[Archibald] - createCustomLocalFolder experiment API starting.");
            const conflict = await this.checkLocalFolderConflict(path);
            if (conflict && conflict.isConflict) {
              if (conflict.isDefaultLocal) {
                throw new Error("Ce dossier est déjà utilisé par Thunderbird pour les Dossiers locaux. Pour utiliser les Dossiers locaux, désactivez simplement l'option \"Dossier personnalisé\".");
              } else {
                throw new Error(`Ce dossier est déjà utilisé par le compte « ${conflict.accountName || "existant"} ». Veuillez en choisir un autre.`);
              }
            }

            const originalAccount = getAccountById(accountId);
            let tmpName = sanitizeName(originalAccount.incomingServer.prettyName);

            // Use a randomUser to prevent errors when creating multiple accounts
            const randomUser = accountId + "_" + Math.random().toString(36).slice(2, 10);
            let srv = MailServices.accounts.createIncomingServer(randomUser, tmpName, "none");
            srv = srv.QueryInterface(Ci.nsIMsgIncomingServer);

            // New local account ("customLocalFolder")
            let account = null;
            let root = null;

            const filespec = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            filespec.initWithPath(path);

            // Ensure the base directory exists and is writable
            if (!filespec.exists()) {
                try {
                    filespec.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
                } catch (e) {
                    console.error("[Archibald] - Cannot create base directory:", path, e);
                    throw e;
                }
            }
            if (!filespec.isDirectory() || !filespec.isWritable()) {
                throw new Error("Base path is not a writable directory: " + path);
            }

            // Detect whether this directory already contains mail-ish content
            console.log("[Archibald] - Searching for pre-existing archives at given location.");
            const hasExistingMail = await hasExistingMailStructure(filespec);

            // Configure server BEFORE account creation
            console.log("[Archibald] - Configuring new local account.");
            srv.prettyName = "Local - " + originalAccount.incomingServer.prettyName;
            srv.localPath = filespec;

            console.log("[Archibald] - Searching storeID.");
            let defaultStoreID;
            if (!hasExistingMail) {
                // For a brand-new repo, force Berkeley mbox.
                defaultStoreID = "@mozilla.org/msgstore/berkeleystore;1";
            } else {
                // For an existing repo you're importing, detect what it is.
                defaultStoreID = await detectStoreType(filespec);
            }
            srv.setStringValue("storeContractID", defaultStoreID);
            srv.emptyTrashOnExit = true;

            // This is a fresh repository
            if (!hasExistingMail)
            {
                console.log("[Archibald] - No existing local folder found at location, creating repository from scratch.");

                // Ensure the repo dir is truly empty before TB initializes it
                const it = filespec.directoryEntries;
                while (it?.hasMoreElements && it.hasMoreElements())
                {
                    const f = it.getNext().QueryInterface(Ci.nsIFile);
                    try { f.remove(true); } catch (_) {}
                }

                // Create the account
                srv.valid = false;
                account = MailServices.accounts.createAccount();
                account.incomingServer = srv;
                srv.valid = true;
                root = srv.rootMsgFolder.QueryInterface(Ci.nsIMsgFolder);

                // Persist account info immediately after creation.
                MailServices.accounts.saveAccountInfo();

                // We must get the folder object again after saving account info, ensuring we have the latest persistent object.
                let trash = root.getChildNamed("Trash") || root.getChildNamed("Corbeille");
                if (trash)
                    await forceMboxLayoutFix(trash);

                // Proactively create "Archives" parent. The helper will ensure the mbox file is created.
                console.log("[Archibald] - Proactively creating Archives parent folder, ignore following error if any.");
                let archives = await ensureSubfolder(root, "Archives");

                // Make it pretty
                if (archives)
                {
                    await forceMboxLayoutFix(archives);
                    try {
                        archives.setFlag ? archives.setFlag(F.Archive) : (archives.flags |= F.Archive);
                    } catch (_) {}
                }

                // Force the parent to recognize the changes AND rebuild all its child databases
                await rebuildFolderDBs(root);

                // Refresh once so TB sees everything
                try { root.updateFolderWithListener(null, null); } catch (_) {}
                await sleep(100);
            }
            // We found an old archive to import here
            else
            {
                // Prepare server object, but keep it invalid for now.
                srv.setStringValue("storeContractID", "@mozilla.org/msgstore/berkeleystore;1");
                srv.localPath = filespec;
                srv.setStringValue("directory", filespec.path);
                try { srv.setStringValue("directory-rel", ""); } catch (e) {
                    console.warn("[Archibald] - Could not clear directory-rel:", e);
                }
                srv.valid = false;

                // Set up account and get temporary root folder object
                account = MailServices.accounts.createAccount();
                account.incomingServer = srv;

                const root = srv.rootMsgFolder.QueryInterface(Ci.nsIMsgFolder);
                const rootLocal = root.QueryInterface(Ci.nsIMsgLocalMailFolder);
                const rootMbox = rootLocal.filePath.clone();

                // Calculate the subfolder directory path (<root>.sbd)
                let subfolderDir = null; // Defined here for scope safety
                try {
                    subfolderDir = rootMbox.clone();
                    subfolderDir.leafName += ".sbd";

                    if (!subfolderDir.exists()) {
                        subfolderDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
                    }
                    console.log("[Archibald] - Subfolder dir for account:", subfolderDir.path);
                } catch (e) {
                    console.error("[Archibald] - Failed to define subfolderDir. Import aborted.", e);
                    return;
                }

                // Move the archive contents into <root>.sbd *while server is invalid*
                console.log("[Archibald] - Adjust existing mboxes by moving content into .sbd");
                moveExistingMboxesIntoRootSbd(filespec, subfolderDir);

                // Rename imported Archive directory to Archives.sbd.
                // This must happen AFTER the move and BEFORE the disk scan/server becomes valid.
                try {
                    const importedArchiveDir = subfolderDir.clone();
                    importedArchiveDir.append("Archives"); // Path: <account>.sbd/Archives

                    const targetArchiveSbd = subfolderDir.clone();
                    targetArchiveSbd.append("Archives.sbd"); // Path: <account>.sbd/Archives.sbd

                    if (importedArchiveDir.exists() && importedArchiveDir.isDirectory()) {
                        console.log("[Archibald] - Renaming imported Archives/ to Archives.sbd/ for proper recursion.");

                        if (!targetArchiveSbd.exists()) {
                            // Rename the stray directory directly
                            importedArchiveDir.moveTo(subfolderDir, "Archives.sbd");
                        } else {
                            // Move contents of stray directory into existing Archives.sbd and remove stray
                            const it = importedArchiveDir.directoryEntries;
                            while (it.hasMoreElements()) {
                                const child = it.getNext().QueryInterface(Ci.nsIFile);
                                child.moveTo(targetArchiveSbd, child.leafName);
                            }
                            importedArchiveDir.remove(true);
                        }
                    }
                } catch (e) {
                    console.error("[Archibald] - Failed to pre-process imported Archives directory:", e);
                }

                // Finalize server link and persist.
                // Now that files are stable, mark the server as valid.
                srv.valid = true;
                MailServices.accounts.saveAccountInfo();

                // Start Folder Mapping and Synchronization
                try {
                    const rootMsgFolder = srv.rootMsgFolder.QueryInterface(Ci.nsIMsgFolder);

                    // Force immediate subfolder loading for UI refresh.
                    try {
                        rootMsgFolder.getSubFolders(true);
                        console.log("[Archibald] - Forcing immediate disk scan by accessing subfolders.");
                    } catch (e) {
                        console.warn("[Archibald] - Failed to force subfolder loading:", e);
                    }

                    // Scan the root directory to find top-level folders like "Archives".
                    console.log("[Archibald] - Scanning disk structure for top-level folders.");
                    const diskTree = scanDiskTree(subfolderDir);

                    // Process default folders (Archives first this time, as it's the conflict point)
                    const F = Ci.nsMsgFolderFlags;
                    const archivesNode = diskTree.find(n => n.name === "Archives");
                    let archives;

                    if (archivesNode) {
                        // Case 1: Archives folder exists on disk (the problematic case).
                        // Create the top-level 'Archives' folder object in TB now.
                        archives = await ensureSubfolder(rootMsgFolder, "Archives");

                        if (archives) {
                            // Set required flags and fix layout on the container folder itself.
                            await forceMboxLayoutFix(archives);
                            archives.setFlag ? archives.setFlag(F.Archive) : (archives.flags |= F.Archive);

                            // Now, build the children tree using the ARCHIVES NODE'S children.
                            console.log("[Archibald] - Building children tree under existing Archives folder.");
                            await buildTbFoldersFromTree(archives, archivesNode.children);
                        }

                        // Remove the Archives node from the diskTree so it's not processed again.
                        diskTree.splice(diskTree.indexOf(archivesNode), 1);
                    } else {
                        // Case 2: Archives does not exist on disk, create the container now.
                        archives = await ensureSubfolder(rootMsgFolder, "Archives");
                        if (archives) {
                            archives.setFlag ? archives.setFlag(F.Archive) : (archives.flags |= F.Archive);
                        }
                    }

                    // Build the rest of the folder tree (excluding Archives, which was processed)
                    console.log("[Archibald] - Building remaining folder tree from disk.");
                    await buildTbFoldersFromTree(rootMsgFolder, diskTree);


                    // Fix Trash folder (always safe)
                    let trash = rootMsgFolder.getChildNamed("Trash") || rootMsgFolder.getChildNamed("Corbeille");
                    if (trash)
                        await forceMboxLayoutFix(trash);

                    // Force indexing of all new folder objects.
                    console.log("[Archibald] - Preparing folders to recieve move commands (Rebuilding DBs).");
                    await rebuildFolderDBs(rootMsgFolder);

                } catch (e) {
                    console.error("[Archibald] - Import process failed during folder mapping/sync:", e);
                }
            }
            // Persist to prefs/accounts
            MailServices.accounts.saveAccountInfo();

            // Force Thunderbird to refresh the folder tree
            // Assigning the server back to itself is a common cache-busting technique.
            account.incomingServer = account.incomingServer;

            return srv.prettyName;
        },
        // ---------------------- CREATE / IMPORT LOCAL ACCOUNT (fin) -------------------------

        // ---------------------- REMOVE LOCAL ACCOUNT -------------------------------
        async removeCustomLocalFolder(accountId)
        {
          const account = MailServices.accounts.getAccount(accountId);
          if (!account)
          {
            console.warn("No account found for key:", accountId);
            return;
          }

          const server = account.incomingServer;
          let localPath;
          try
          {
            localPath = server.localPath; // nsIFile
          }
          catch (e)
          {
            localPath = null;
          }

          // This removes the account from Thunderbird and also removes the incoming server.
          // removeFiles = true tries to delete messages / localPath on disk.
          const removeFiles = false;
          MailServices.accounts.removeAccount(account, removeFiles);

          // Persist to prefs
          MailServices.accounts.saveAccountInfo();

          // Optional extra cleanup if you want to be absolutely sure the directory is gone:
          if (removeFiles && localPath && localPath.exists())
          {
            try
            {
              await IOUtils.remove(localPath.path, { recursive: true });
            }
            catch (e)
            {
              console.warn("Failed to remove local directory:", localPath.path, e);
            }
          }

          console.log("[Archibald] - Custom local account removed:", accountId);
        },
        // ---------------------- REMOVE LOCAL ACCOUNT -------------------------------



        // ---------------------- CREATE LOCAL FOLDER TREE -------------------------
        async createArchiveLocalFolder(accountId, name, parentPath)
        {
          try
          {
            // Find the account using helper or getAccount
            let account = getAccountById(accountId) || MailServices.accounts.getAccount(accountId);
            if (!account)
              throw new Error(`Account with ID "${accountId}" not found`);

            // Get root folder
            let rootFolder = account.incomingServer.rootFolder;

            // Create Archives folder if it doesn't already exists
            if (!rootFolder.containsChildNamed("Archives"))
              rootFolder.createSubfolder("Archives", null);

            // Find parent folder by path (default to root)
            parentPath = "/Archives/" + (parentPath || "");
            let parent = rootFolder;

            if (parentPath && parentPath !== "/")
            {
              const parts = parentPath.split("/").filter(p => p);
              for (let part of parts)
              {
                const cleanPart = part.replaceAll("/", "／");
                if (!parent.containsChildNamed(cleanPart))
                  parent.createSubfolder(cleanPart, null);

                parent = parent.getChildNamed(cleanPart);
              }
            }

            // Create folder if it doesn't already exist
            const cleanName = name.replaceAll("/", "／");
            if (!parent.containsChildNamed(cleanName))
            {
              //console.log("[Archibald] - createArchiveLocalFolder - creating " + name);
              parent.createSubfolder(cleanName, null);
            }

            return "";
          }
          catch (e)
          {
            console.error("[Archibald] - Error in createArchiveLocalFolder:", e);
            throw e;
          }

          return "";
        },

        // expose the event to background.js
        onArchive: onArchiveEvent,
      },
       // ---------------------- CREATE LOCAL FOLDER TREE (fin) -------------------------
    };
  }
};
