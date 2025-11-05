var { classes: Cc, interfaces: Ci } = Components;

// ESM imports that should work in TB 115+/128/140+
const { MailServices } = ChromeUtils.importESModule("resource://gre/modules/MailServices.sys.mjs");
const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

// Use Window Mediator via XPCOM (avoids Services import)
const WM = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
const F = Ci.nsMsgFolderFlags;

// ================================= HELPERS ============================================
function getTopChromeWindow() {
  return WM.getMostRecentWindow("mail:3pane") || WM.getMostRecentWindow(null);
}

function initPickerWithParent(picker, parentWin, title, modeConst) {
  const bc = parentWin?.browsingContext;
  try {
    if (bc) { picker.init(bc, title, modeConst); return; }
  } catch (_) {}
  picker.init(parentWin, title, modeConst);
}

function getAccountById(accountId) {
  // MailServices.accounts.accounts is an nsIArray of nsIMsgAccount
  for (const account of MailServices.accounts.accounts) {
    if (account.key === accountId) {
      return account;
    }
  }
  return null;
}

function sanitizeName(str) {
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
function sleep(ms) {
  return new Promise(resolve => {
    const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.init(() => resolve(), ms, Ci.nsITimer.TYPE_ONE_SHOT);
  });
}

async function ensureSpecialSubfolder(parent, name, flag) {
  try { parent.createSubfolder(name, null); } catch (_) {}
  let f = null;
  for (let i = 0; i < 10 && !f; i++) {
    try { f = parent.getChildNamed(name); } catch (_) {}
    if (!f) {
      try { parent.updateFolderWithListener(null, null); } catch (_) {}
      await sleep(50); // yield so TB can process folder creation
    }
  }
  if (!f) return;
  try { f = f.QueryInterface(Ci.nsIMsgFolder); } catch (_) {}
  try { f.setFlag ? f.setFlag(flag) : (f.flags |= flag); } catch (_) {}
  try { if (f instanceof Ci.nsIMsgLocalMailFolder) f.createStorageIfMissing(null); } catch (_) {}
  try { f.updateFolderWithListener(null, null); } catch (_) {}
}

async function ensureSubfolder(parent, name)
{
  // Create (ok if it already exists)
  try { parent.createSubfolder(name, null); } catch (_) {}

  // Find it (allow a few cycles for TB to register the new child)
  let f = null;
  for (let i = 0; i < 10 && !f; i++) {
    try { f = parent.getChildNamed(name); } catch (_) {}
    if (!f) {
      try { parent.updateFolderWithListener(null, null); } catch (_) {}
      await sleep(50); // yield so TB can process folder creation
    }
  }
  if (!f) return null;

  // Make it usable immediately
  try { f = f.QueryInterface(Ci.nsIMsgFolder); } catch (_) {}
  try {
    if (f instanceof Ci.nsIMsgLocalMailFolder) {
      f.createStorageIfMissing(null); // ensure mbox + .msf exist
    }
  } catch (_) {}
  try { f.updateFolderWithListener(null, null); } catch (_) {}

  return f; // nsIMsgFolder, ready for moves
}


async function indexAllFolders(folder) {
  try { folder.updateFolderWithListener(null, null); } catch (_) {}
  const s = folder.subFolders;
  if (!s) return;

  if (typeof s.hasMoreElements === "function") {
    while (s.hasMoreElements()) {
      let sf = s.getNext();
      try { sf = sf.QueryInterface(Ci.nsIMsgFolder); } catch (_) {}
      await indexAllFolders(sf);
    }
  } else if (Symbol.iterator in Object(s)) {
    for (let sf of s) {
      try { sf = sf.QueryInterface(Ci.nsIMsgFolder); } catch (_) {}
      await indexAllFolders(sf);
    }
  }
}

function diagLocalFolder(nsFolder) {
  nsFolder = nsFolder.QueryInterface(Ci.nsIMsgFolder);
  console.log("dest URI:", nsFolder.URI, "canFileMessages:", nsFolder.canFileMessages);

  try {
    const local = nsFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
    const file = local.filePath; // nsIFile: the mbox file expected on disk
    console.log("mbox path:", file.path, "exists:", file.exists(), "isDir:", file.isDirectory(), "writable:", file.isWritable());
  } catch (e) {
    console.warn("Not a local mail folder?", e);
  }

  try { void nsFolder.msgDatabase; console.log("msgDatabase ok"); } catch (e) {
    console.warn("msgDatabase open failed:", e);
  }
}

async function repairMboxLayout(nsFolder /* nsIMsgFolder */) {
  nsFolder = nsFolder.QueryInterface(Ci.nsIMsgFolder);
  const local = nsFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);

  // Paths
  const mbox = local.filePath; // C:\...\Archives   (should be a FILE)
  const parentDir = mbox.parent;
  const sbd = mbox.clone(); sbd.leafName = mbox.leafName + ".sbd";

  // If the mbox "file" is actually a DIRECTORY, convert layout:
  if (mbox.exists() && mbox.isDirectory()) {
    // If Archives.sbd doesn't exist yet, turn the wrong dir into the .sbd
    if (!sbd.exists()) {
      mbox.moveTo(parentDir, mbox.leafName + ".sbd"); // Archives -> Archives.sbd
    } else {
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

  // Ensure the mbox FILE exists (empty is fine)
  if (!mbox.exists()) {
    // createStorageIfMissing will create the mbox + .msf
    local.createStorageIfMissing(null);
  }

  // Make sure .sbd exists if there are/will be children
  if (!sbd.exists()) {
    try { sbd.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700); } catch (_) {}
  }

  try { nsFolder.updateFolderWithListener(null, null); } catch (_) {}
  try { void nsFolder.msgDatabase; } catch (_) {}
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
          if (options.startDir) {
            try {
              const start = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
              start.initWithPath(options.startDir);
              picker.displayDirectory = start;
            } catch (e) {
              console.warn("[archibaldApi.showFilePicker] startDir failed:", e);
            }
          }

          // Optional filters: [{ name, extensions: ["pdf","txt"] }]
          if (Array.isArray(options.filters)) {
            try {
              for (const f of options.filters) {
                if (f?.name && Array.isArray(f.extensions)) {
                  const pat = f.extensions.map(ext => "*." + ext).join(";");
                  picker.appendFilter(String(f.name), pat);
                }
              }
            } catch (e) {
              console.warn("[archibaldApi.showFilePicker] filters failed:", e);
            }
          }

          // Open and return paths
          return await new Promise((resolve) => {
            try {
              picker.open((rv) => {
                const ok = (rv === Ci.nsIFilePicker.returnOK || rv === Ci.nsIFilePicker.returnReplace);
                if (!ok) return resolve([]);

                if (mode === Ci.nsIFilePicker.modeOpenMultiple) {
                  const out = [];
                  const it = picker.files;
                  while (it && it.hasMoreElements()) {
                    const f = it.getNext().QueryInterface(Ci.nsIFile);
                    if (f?.path) out.push(f.path);
                  }
                  return resolve(out);
                }

                const path = picker.file?.path || "";
                resolve(path ? [path] : []);
              });
            } catch (e) {
              console.error("[archibaldApi.showFilePicker] picker.open threw:", e);
              resolve([]);
            }
          });
        },
        // ---------------------- PICK A PATH (fin) -------------------------

        // ---------------------- CREATE LOCAL ACCOUNT -------------------------
        async createCustomLocalFolder(accountId, path)
        {
          //console.log("createCustomLocalFolder");
          const originalAccount = getAccountById(accountId);
          let tmpName = sanitizeName(originalAccount.incomingServer.prettyName);

          //console.log("create incoming server");
          // Use a randomUser to prevent errors when creating multiple accounts
          const randomUser = "user_" + Math.random().toString(36).slice(2, 10);
          let srv = MailServices.accounts.createIncomingServer("randomUser", tmpName, "none");
          srv = srv.QueryInterface(Ci.nsIMsgIncomingServer);

          //console.log("init with path " + path);
          const filespec = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          filespec.initWithPath(path);

          //console.log("ensure the base directory exists and is writable");
          if (!filespec.exists()) {
            try { filespec.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700); } catch (e) {
              console.error("Cannot create base directory:", path, e);
              throw e;
            }
          }
          if (!filespec.isDirectory() || !filespec.isWritable()) {
            throw new Error("Base path is not a writable directory: " + path);
          }

          //console.log("set pretty name " + originalAccount.incomingServer.prettyName + " - Local");
          srv.prettyName = "Local - " + originalAccount.incomingServer.prettyName;
          srv.localPath = filespec;

          // mbox store (Berkeley)
          //console.log("set store contract id");
          const defaultStoreID = "@mozilla.org/msgstore/berkeleystore;1";
          srv.setStringValue("storeContractID", defaultStoreID);
          srv.emptyTrashOnExit = true;

          // Clean leftovers
          //console.log("clean folders");
          await IOUtils.remove(PathUtils.join(path, "Trash"), { ignoreAbsent: true, recursive: true });
          await IOUtils.remove(PathUtils.join(path, "Unsent Messages"), { ignoreAbsent: true, recursive: true });

          // Create the account
          //console.log("create account");
          srv.valid = false;
          const account = MailServices.accounts.createAccount();
          account.incomingServer = srv;
          srv.valid = true;

          // Fix/ensure special folders exist and are usable on disk (replaces fixupSubfolder/addSpecialFolders)
          //console.log("create special folders");
          const root = srv.rootMsgFolder.QueryInterface(Ci.nsIMsgFolder);
          await ensureSpecialSubfolder(root, "Trash",           F.Trash);
          await ensureSpecialSubfolder(root, "Unsent Messages", F.Queue);

          // Proactively create "Archives" parent (Berkeley needs mbox file + .sbd for children)
          const archives = await ensureSubfolder(root, "Archives");
          try { archives.setFlag ? archives.setFlag(F.Archive) : (archives.flags |= F.Archive); } catch (_) {}

          // Repair wrong on-disk shape if needed
          await repairMboxLayout(archives);

          // One more pass to discover everything
          try { root.updateFolderWithListener(null, null); } catch (_) {}
          await sleep(50);

          // Import/index existing on-disk structure so moves work immediately (replaces addExistingFolders)
          //console.log("index folders");
          await indexAllFolders(root);

          //console.log("return created account id");*/
          // Persist to prefs/accounts
          MailServices.accounts.saveAccountInfo();

          // As crazy as it reads, this refresh thunderbird's folder tree
          account.incomingServer = account.incomingServer;

          //console("quick diagnostics (keep while testing)");
          try {
            console.log("Root URI:", root.URI, "canFile:", root.canFileMessages);
            console.log("Archives canFile:", archives.canFileMessages);
            try {
              const local = archives.QueryInterface(Ci.nsIMsgLocalMailFolder);
              const file  = local.filePath;
              console.log("Archives mbox:", file.path, "exists:", file.exists(), "isDir:", file.isDirectory(), "writable:", file.isWritable());
            } catch(e) {}
          } catch(e) { console.warn("Diag failed:", e); }

          // Return the XPCOM account key (e.g. "account7")
          return srv.prettyName;
        },
        // ---------------------- CREATE LOCAL ACCOUNT (fin) -------------------------

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
            try {
              await IOUtils.remove(localPath.path, { recursive: true });
            } catch (e) {
              console.warn("Failed to remove local directory:", localPath.path, e);
            }
          }

          console.log("Custom local account removed:", accountId);
        },
        // ---------------------- REMOVE LOCAL ACCOUNT -------------------------------



        // ---------------------- CREATE LOCAL FOLDER TREE -------------------------
        async createArchiveLocalFolder(accountId, name, parentPath) {
          // Find the account
          let account = MailServices.accounts.accounts.find(acc => acc.key === accountId);
          if (!account) {
            throw new Error(`Account with ID "${accountId}" not found`);
          }

          // Get root folder
          let rootFolder = account.incomingServer.rootFolder;

          // Create Archives folder if it doesn't already exists
          if (!rootFolder.containsChildNamed("Archives")) {
            rootFolder.createSubfolder("Archives", null);
          }

          // Find parent folder by path (default to root)
          parentPath = "/Archives/" + parentPath;
          let parent = rootFolder;

          if (parentPath && parentPath !== "/") {
            const parts = parentPath.split("/").filter(p => p);
            for (let part of parts) {
              if (!parent.containsChildNamed(part.replaceAll("/", "／"))) {
                throw new Error(`Parent folder "${parentPath}" not found`);
              }
              parent = parent.getChildNamed(part.replaceAll("/", "／"));
            }
          }

          // Create folder if it doesn't already exist
          if (!parent.containsChildNamed(name.replaceAll("/", "／"))) {
            console.log("createArchiveLocalFolder - creating " + name);
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
