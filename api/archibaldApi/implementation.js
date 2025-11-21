var { classes: Cc, interfaces: Ci } = Components;

// ESM imports that should work in TB 115+/128/140+
const { MailServices } = ChromeUtils.importESModule("resource://gre/modules/MailServices.sys.mjs");
const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

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
// ================================= FIN HELPERS ============================================

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
        init() {},

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

        // ---------------------- CREATE / IMPORT LOCAL ACCOUNT -------------------------
        async createCustomLocalFolder(accountId, path)
        {
            console.log("[Archibald] - createCustomLocalFolder experiment API starting.");
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
          // Find the account
          let account = MailServices.accounts.accounts.find(acc => acc.key === accountId);
          if (!account)
            throw new Error(`Account with ID "${accountId}" not found`);

          // Get root folder
          let rootFolder = account.incomingServer.rootFolder;

          // Create Archives folder if it doesn't already exists
          if (!rootFolder.containsChildNamed("Archives"))
            rootFolder.createSubfolder("Archives", null);

          // Find parent folder by path (default to root)
          parentPath = "/Archives/" + parentPath;
          let parent = rootFolder;

          if (parentPath && parentPath !== "/")
          {
            const parts = parentPath.split("/").filter(p => p);
            for (let part of parts)
            {
              if (!parent.containsChildNamed(part.replaceAll("/", "／")))
                throw new Error(`Parent folder "${parentPath}" not found`);

              parent = parent.getChildNamed(part.replaceAll("/", "／"));
            }
          }

          // Create folder if it doesn't already exist
          if (!parent.containsChildNamed(name.replaceAll("/", "／")))
          {
            //console.log("[Archibald] - createArchiveLocalFolder - creating " + name);
            parent.createSubfolder(name, null);
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
