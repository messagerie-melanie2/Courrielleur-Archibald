var {classes: Cc, interfaces: Ci} = Components;
const { MailServices } = ChromeUtils.importESModule("resource://gre/modules/MailServices.sys.mjs");
const { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

this.archibaldApi = class extends ExtensionAPI {
  getAPI(context) {
    console.log("Archibald implementation loaded.");

    // Define an event manager for forwarding TbArchive events
    const onArchiveEvent = new ExtensionCommon.EventManager({
      context,
      name: "archibaldApi.onArchive",
      register: (fire) => {
        const listener = (eventName, messages) => {
          console.log("Archibald received TbArchive in implementation from Thunderbird core:", messages);
          fire.async(messages);
        };

        this.extension.on("TbArchive", listener);

        return () => {
          this.extension.off("TbArchive", listener);
        };
      },
    }).api();

    return {
      archibaldApi: {
        init() {},

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

          // For now return empty string (your TODO from before)
          return "";
        },

        // expose the event to background.js
        onArchive: onArchiveEvent,
      },
    };
  }
};