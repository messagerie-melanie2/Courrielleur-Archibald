var { classes: Cc, interfaces: Ci } = Components;

// ESM imports that should work in TB 115+/128/140+
const { MailServices } = ChromeUtils.importESModule("resource://gre/modules/MailServices.sys.mjs");
const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

// Use Window Mediator via XPCOM (avoids Services import)
const WM = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);

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

async function fixupSubfolder(parentName, folderName, removeFileFolder, storeID)
{
  var filespec = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  var rf = `${parentName}\\${folderName}`

  filespec.initWithPath(parentName);
  filespec.append(folderName);

  if (removeFileFolder) {
      let fullPath = PathUtils.join(parentName, folderName);
      if (await IOUtils.exists(fullPath)) {
          await IOUtils.remove(fullPath);
          return;
      }
  }

  // We need to tweak subfolders differently for storage type
  // mbox - remove local directory, create empty mail file
  // maildir - create directory

  if (storeID !== "@mozilla.org/msgstore/maildirstore;1") {
      //eu.philoux.localfolder.LocalFolderTrace(`removing file folder: ${rf}`);
      try {
          filespec.remove(true);
          //eu.philoux.localfolder.LocalFolderTrace(`fixupSubfolder - removed folder`);
      } catch (error) {
          //eu.philoux.localfolder.LocalFolderTrace(`no folder found removing file folder: ${rf}`);
      }
  }

  if (storeID === "@mozilla.org/msgstore/maildirstore;1") {
      filespec.create(Ci.nsIFile.DIRECTORY_TYPE, 0755);
      //eu.philoux.localfolder.LocalFolderTrace(`fixupSubfolder done - CREATED DIRECTORY`);

  } else {
      filespec.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0644);
      //eu.philoux.localfolder.LocalFolderTrace(`fixupSubfolder done - create file`);
  }
}

async function addSpecialFolders(aParentFolder, aParentFolderPath)
{
  let addFolderElements = document.querySelectorAll("[id^='add_folder_']");

  var bundle = Services.strings.createBundle("chrome://messenger/locale/messenger.properties");
  msgWindow = Cc["@mozilla.org/messenger/msgwindow;1"].createInstance(Ci.nsIMsgWindow);

  for (let index = 0; index < addFolderElements.length; index++) {
    const element = addFolderElements[index];
    if (!!element.checked) {
        // Add special folder
        const l = element.getAttribute("SpecialFolder");
        const storeID = aParentFolder.server.getStringValue("storeContractID");

        var ll = specialFolders[l].localizedFolderName;
        //eu.philoux.localfolder.LocalFolderTrace('Add special folder: ' + l + '  ' + storeID + "   " + ll);

        // Trash and unsent messages folders are added at account creation
        if (l !== "Trash" && l !== "Outbox" && !existingSpecialFolders.includes(l)) {

            aParentFolder.createSubfolder(l, msgWindow);

            // eu.philoux.localfolder.LocalFolderTrace("Added subfolder : " + l);
            var localizedFolderString = bundle.GetStringFromName(ll);
            var e = aParentFolder.subFolders;

            try {
                aParentFolder.getChildNamed(localizedFolderString).flags = eu.philoux.localfolder.specialFolders[l].flags;
                // eu.philoux.localfolder.LocalFolderTrace("child " + localizedFolderString);
            } catch (error) {
                // eu.philoux.localfolder.LocalFolderTrace("child not found TryEnglish");
                aParentFolder.getChildNamed(l).flags = eu.philoux.localfolder.specialFolders[l].flags;
            }

            await fixupSubfolder(aParentFolderPath, l, false, storeID);
        }
    }
  }
}

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
          const originalAccount = getAccountById(accountId);
          let tmpName = sanitizeName(originalAccount.incomingServer.prettyName);
          console.log(tmpName);
          var srv = MailServices.accounts.createIncomingServer("nobody", tmpName, "none");

          srv = srv.QueryInterface(Ci.nsIMsgIncomingServer);

          var filespec = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          filespec.initWithPath(path);
          srv.prettyName = originalAccount.incomingServer.prettyName + " - Local";
          srv.localPath = filespec;

          let defaultStoreID = "@mozilla.org/msgstore/berkeleystore;1";
          srv.setStringValue("storeContractID", defaultStoreID);
          srv.emptyTrashOnExit = true;

          // maildir will not setup without Trash & Unsent Messages being removed, mbox op is non issue
          await IOUtils.remove(PathUtils.join(path, "Trash"), { ignoreAbsent: true, recursive: true });
          await IOUtils.remove(PathUtils.join(path, "Unsent Messages"), { ignoreAbsent: true, recursive: true });

          srv.valid = false;

          var account = MailServices.accounts.createAccount();
          account.incomingServer = srv;
          srv.valid = true;
          account.incomingServer = account.incomingServer;

          return account.id;
      },
        // ---------------------- CREATE LOCAL ACCOUNT (fin) -------------------------


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
