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

async function ensureSubfolder(parent, name)
{
  // Create (ok if it already exists)
  try { parent.createSubfolder(name, null); } catch (_) {}

  // Find it (allow a few cycles for TB to register the new child)
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
  if (!f) return null;

  // Make it usable immediately
  try { f = f.QueryInterface(Ci.nsIMsgFolder); } catch (_) {}
  try
  {
    if (f instanceof Ci.nsIMsgLocalMailFolder) {
      f.createStorageIfMissing(null); // ensure mbox + .msf exist
    }
  } catch (_) {}
  try { f.updateFolderWithListener(null, null); } catch (_) {}

  return f; // nsIMsgFolder, ready for moves
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
  for (const node of children)
  {
    let tbChild;
    try
    {
      // Your existing helper that creates subfolder if needed
      tbChild = await ensureSubfolder(parentTbFolder, node.name);
    }
    catch (e)
    {
      console.warn("[Archibald] - ensureSubfolder failed for", node.name, "under", parentTbFolder.name, e);
      continue;
    }

    if (node.children && node.children.length)
      await buildTbFoldersFromTree(tbChild, node.children);
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
          const originalAccount = getAccountById(accountId);
          let tmpName = sanitizeName(originalAccount.incomingServer.prettyName);

          // Use a randomUser to prevent errors when creating multiple accounts
          const randomUser = accountId + "_" + Math.random().toString(36).slice(2, 10);
          let srv = MailServices.accounts.createIncomingServer(randomUser, tmpName, "none");
          srv = srv.QueryInterface(Ci.nsIMsgIncomingServer);
          // The new local account we will create later, this is the "customLocalFolder"
          let account = null;
          // The root of the new account
          let root = null;

          const filespec = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          filespec.initWithPath(path);

          // Ensure the base directory exists and is writable
          if (!filespec.exists())
          {
            try
            {
              filespec.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            }
            catch (e)
            {
              console.error("Cannot create base directory:", path, e);
              throw e;
            }
          }
          if (!filespec.isDirectory() || !filespec.isWritable())
            throw new Error("Base path is not a writable directory: " + path);

          // Detect whether this directory already contains mail-ish content
          const hasExistingMail = await hasExistingMailStructure(filespec);

          // Set name and localPath
          srv.prettyName = "Local - " + originalAccount.incomingServer.prettyName;
          srv.localPath = filespec;

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

          // This seems to be a fresh directory, let's create a local folders tree normaly
          if (!hasExistingMail)
          {
            console.log("[Archibald] - No existing local folder found at location, creating repository from scratch.");

            // Make sure this account will use "move to trash" semantics
            try {
              srv.setIntValue("delete_model", 0);
            } catch (e) {
              console.warn("[Archibald] - Could not set delete_model:", e);
            }

            // Create the account
            srv.valid = false;
            account = MailServices.accounts.createAccount();
            account.incomingServer = srv;
            srv.valid = true;
            root = srv.rootMsgFolder.QueryInterface(Ci.nsIMsgFolder);

            // Explicitly create a Trash folder named *"Trash"* and mark it as Trash
            const trash = await ensureSpecialSubfolder(root, "Trash", F.Trash);
            if (trash) {
              console.log("[Archibald] - Created Trash folder:", trash.name, trash.URI);

              // For a fresh mbox Trash just created by TB APIs, we DO NOT need repairMboxLayout.
              // It's already in the correct "Trash" mbox + "Trash.sbd" shape.
              try {
                srv.setCharValue("trash_folder_name", trash.name); // "Trash"
              } catch (e) {
                console.warn("[Archibald] - Could not set trash_folder_name:", e);
              }
            }
            else
            {
              console.warn("[Archibald] - Failed to create Trash folder under", root.URI);
            }

            // Proactively create "Archives" parent (Berkeley needs mbox file + .sbd for children)
            console.log("[Archibald] - Proactively creating Archives parent folder");
            const archives = await ensureSubfolder(root, "Archives");
            try { archives.setFlag ? archives.setFlag(F.Archive) : (archives.flags |= F.Archive); } catch (_) {}
            await repairMboxLayout(archives);

            // One more pass to discover everything
            try { root.updateFolderWithListener(null, null); } catch (_) {}
            await sleep(50);

            // rebuild existing on-disk structure so moves work immediately
            await rebuildFolderDBs(root);
          }
          // This seems to be an existing directory, let's try to import what's in there
          else
          {
            console.log("[Archibald] - Found local folder at given location, starting importation.");

            // Force Berkeley store for imported archives.
            //    (If detectStoreType got this wrong, messages will never show up.)
            srv.setStringValue("storeContractID", "@mozilla.org/msgstore/berkeleystore;1");

            // Point the server at the copy directory and persist it
            srv.localPath = filespec;
            srv.setStringValue("directory", filespec.path);
            try { srv.setStringValue("directory-rel", ""); } catch (e) { console.warn("[Archibald] - Could not clear directory-rel:", e); }

            // Create the account and get the root folder
            srv.valid = false;
            account = MailServices.accounts.createAccount();
            account.incomingServer = srv;
            srv.valid = true;

            root = srv.rootMsgFolder.QueryInterface(Ci.nsIMsgFolder);
            const rootLocal = root.QueryInterface(Ci.nsIMsgLocalMailFolder);

            // Compute the directory that will hold subfolders for this account
            const rootMbox = rootLocal.filePath.clone();
            let subfolderDir = rootMbox.clone();
            subfolderDir.leafName += ".sbd";
            if (!subfolderDir.exists())
              subfolderDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            console.log("[Archibald] - Subfolder dir for account:", subfolderDir.path);

            // Move the copied archive contents under <root>.sbd (mbox + .sbd, but NO .msf)
            console.log("[Archibald] - Adjusting existing mboxes");
            moveExistingMboxesIntoRootSbd(filespec, subfolderDir);

            // Scan the on-disk tree and create TB folders to match it
            console.log("[Archibald] - Building folder tree from disk, Thunderbird wont like this, ignore the following errors...");
            const diskTree = scanDiskTree(subfolderDir);
            await buildTbFoldersFromTree(root, diskTree);
            console.log("[Archibald] - Ok Thunderbird, thanks.");

            // Debug method
            /*const f2016 = getChildIgnoreCase(root, "2016");
            if (f2016) debugFolderStorage(f2016);*/

            // If Archive doesn't already exists, make sure it is ready and properly formated
            let archives = getChildIgnoreCase(root, "Archives");
            if (!archives)
            {
              // Proactively create "Archives" parent (Berkeley needs mbox file + .sbd for children)
              console.log("[Archibald] - Proactively creating Archives parent folder");
              archives = await ensureSubfolder(root, "Archives");
              try { archives.setFlag ? archives.setFlag(F.Archive) : (archives.flags |= F.Archive); } catch (_) {}
              await repairMboxLayout(archives);
              await repairMboxLayout(getChildIgnoreCase(root, "Corbeille"));
            }



            // One more pass to discover everything
            console.log("[Archibald] - Checking if everything is in order");
            try { root.updateFolderWithListener(null, null); } catch (_) {}
            await sleep(50);

            // rebuild existing on-disk structure so moves work immediately
            console.log("[Archibald] - Preparing folders to recieve move commands");
            await rebuildFolderDBs(root);
          }

          // Persist to prefs/accounts
          MailServices.accounts.saveAccountInfo();

          // Force Thunderbird to refresh the folder tree
          account.incomingServer = account.incomingServer;

          // Diagnostics (optional)
          /*try
          {
            console.log("[Archibald] - Diag root URI:", root.URI, "canFile:", root.canFileMessages);
            const archives = getChildIgnoreCase(root, "Archives");
            if (archives)
            {
              console.log("[Archibald] - Archives canFile:", archives.canFileMessages);
              try
              {
                const local = archives.QueryInterface(Ci.nsIMsgLocalMailFolder);
                const file  = local.filePath;
                console.log("[Archibald] - Archives mbox:", file.path,
                            "exists:", file.exists(),
                            "isDir:", file.isDirectory(),
                            "writable:", file.isWritable());
              }
              catch(e) {}
            }
          }
          catch(e) { console.warn("[Archibald] - Diag failed:", e); }*/

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
