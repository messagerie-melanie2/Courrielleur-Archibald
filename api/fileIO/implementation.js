var {classes: Cc, interfaces: Ci} = Components;
var { MailServices } = ChromeUtils.import("resource:///modules/MailServices.jsm");

this.fileIO = class extends ExtensionAPI {
  getAPI(context) {
    return {
      fileIO: {
        async createArchiveLocalFolder(accountId, name) {
          // Find the account
          let account = MailServices.accounts.accounts.find(acc => acc.key === accountId);
          if (!account) {
            throw new Error(`Account with ID "${accountId}" not found`);
          }

          // Get root folder
          let rootFolder = account.incomingServer.rootFolder;
          // Create Archives folder if it doesn't already exists
          if (!rootFolder.containsChildNamed("Archives"))
            rootFolder.createSubfolder("Archives", null);

          // Find parent folder by path (default to root)
          const parentPath = "/Archives";
          let parent = rootFolder;

          if (parentPath && parentPath !== "/") {
            const parts = parentPath.split("/").filter(p => p);
            for (let part of parts) {
              if (!parent.containsChildNamed(part)) {
                throw new Error(`Parent folder "${parentPath}" not found`);
              }
              parent = parent.getChildNamed(part);
            }
          }

          // Create folder if it doesn't already exist
          if (!parent.containsChildNamed(name)) {
            parent.createSubfolder(name, null);
          }

          // folder Uri is like mailbox://nobody@Local%20Folders/Archives/2016
          const folder = parent.getChildNamed(name);
          const folderPath = folder.prettyPath || folder.filePath || "";
          const normalizedPath = folderPath.startsWith("/") ? folderPath.slice(1) : folderPath;
          const webExtFolderId = `${accountId}://${normalizedPath}`;
          console.log("WebExtension Folder ID:", webExtFolderId);

          return webExtFolderId;
        }
      }
    };
  }
};