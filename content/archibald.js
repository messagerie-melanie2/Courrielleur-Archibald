let archiveCount = 0;
let pendingMode = false;

// List all available accounts
async function populateInboxDropdown() {
  const dropdown = document.getElementById("mailboxDropdown");
  dropdown.innerHTML = "";

  const accounts = await browser.accounts.list();

  for (const account of accounts) {
    if(account.type == "imap")
    {
      const option = document.createElement("option");
      option.value = JSON.stringify({
        accountId: account.id
      });
      option.textContent = `${account.name}`;
      dropdown.appendChild(option);
    }
  }

  selectedAccountChanged();
}
populateInboxDropdown();

// Dynamicly adjust date and day counts
document.addEventListener("DOMContentLoaded", async () => {
  // Create listeners for form actions
  document.getElementById("btSelectNewLocalFolder").addEventListener("click", () => {selectNewLocalFolder();});
  document.getElementById("useCustomLocalFolder").addEventListener("change", () => {useCustomLocalFolderChanged();});
  document.getElementById("btRemoveCustomLocalFolder").addEventListener("click", () => {removeCustomLocalFolder();});

  // Check if we have some data to process when this tab opens
  let pendingMessages = null;
  try
  {
    const { thunderbirdRequest } = await browser.storage.local.get("thunderbirdRequest");
    if (thunderbirdRequest && Array.isArray(thunderbirdRequest.messages) && thunderbirdRequest.messages.length)
    {
      archibaldLog("Additional data recieved from background.js:");
      thunderbirdRequest.messages.forEach((msg, index) => {
        archibaldLog(`Message[${index}]:`);
        archibaldLog("id: " + msg.messageId);
        archibaldLog("folderURI: " + msg.folderURI);
        archibaldLog("folderName: " + msg.folderName);
        archibaldLog("accountId: " + msg.accountId);
      });
      pendingMessages = thunderbirdRequest.messages;
      pendingMode = true;
    }
  }
  catch (ex) {
    archibaldLog(" No additional data. Archibald likely opened through user action.");
  }


  const daysInput = document.getElementById("days");
  const dateInput = document.getElementById("until");

  // Update date when days change
  daysInput.addEventListener("input", () => {
    const days = parseInt(daysInput.value, 10) - 1;
    if (!isNaN(days)) {
      const now = new Date();
      now.setHours(0, 0, 0, 0); // Ensure midnight
      const targetDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
      dateInput.value = targetDate.toISOString().split("T")[0]; // format yyyy-mm-dd
    }
  });

  // Update days when date changes
  dateInput.addEventListener("input", () => {
    const selectedDate = new Date(dateInput.value);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (!isNaN(selectedDate.getTime())) {
      const diffTime = now.getTime() - selectedDate.getTime();
      const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
      daysInput.value = diffDays;
    }
  });

  // Default value to one year from current date
  const oneYearFromNow = new Date();
  oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() - 1);
  const formattedDate = oneYearFromNow.toISOString().split('T')[0];
  dateInput.value = formattedDate;

  restoreFormFromLocalStorage();

  if(pendingMessages != null)
  {
    processPendingMessages(pendingMessages);
    pendingMessages = null;
  }
});

async function processPendingMessages(messages)
{
  // What are we doing here if there is nothing to archive, just cancel
  if(!messages || messages.length == 0)
  {
    displayArchibaldMessage("");
    return;
  }

  // Use the first pending messages to know where we stand
  const accountId = messages[0].accountId;
  const folderURI = messages[0].folderURI;
  let archiveCount = 0;

  // Current Account
  const accounts = await browser.accounts.list();
  const account = accounts.find(acc => acc.id === accountId);

  if (!account)
    throw new Error("Account not found.");

  // We use the previously Selected Folders
  let storedFolders = await browser.storage.local.get(accountId);
  // This is the first time we use Archibald, we need to construct the folder base list
  if(storedFolders[accountId] == undefined)
  {
    await setDefaultFoldersForAccount(accountId);
    storedFolders = await browser.storage.local.get(accountId);
  }

  const pendingFolders = storedFolders[accountId];

  // Retrieve and clean folders needed for this pendingMessage from folderUri (imap://account/folder1/folder2...)
  let pendingMessageFolders = folderURI.split("/").slice(3);
  let currentPath = "";

  // Artificially add the folders of the pendingMessage to create them if needed
  pendingMessageFolders.forEach(folderName => {
    currentPath += "/" + folderName;
    let folder = {
      name: decodeLegacyFolderName(folderName),
      path: currentPath,
      id: accountId + "://" + currentPath.slice(1), // remove leading slash
      accountId: accountId
    };

    // Add it to the array if needed
    if (!pendingFolders.some(f => f.path === folder.path)) {
      pendingFolders.push(folder);
    }
  });

  // We don't need the date for a pendingMessage
  // Prepare window style
  readyArchibaldWindow();

  // Simply download a zip folder
  //downloadAsZip(storedFoldersForSelectedAccount, new Date(selectedDate.value));

  // Find the local account of this profile
  const localAccount = accounts.find(acct => acct.type === "local");
  if (!localAccount)
    throw new Error("Local account not found.");

  // Create folder hierarchy of selected account under found localAccount
  await createAccountLocalFolders(account, localAccount, pendingFolders);

  // Move the pendingMessages to the corresponding localAccount folders
  archiveCount = await localyArchivePendingMessages(messages, account, currentPath);

  // Reset window style
  setTimeout(() => {
    resetArchibaldWindow();
    if(archiveCount > 0)
    {
      document.getElementById("statusLabel").textContent = "Archivage terminé ! " + archiveCount + " messages déplacés.";
    }
    else
    {
      document.getElementById("statusLabel").textContent = "Aucun message à archiver.";
    }
    archiveCount = 0;
  }, 200);

  // Clear messages
  await browser.storage.local.set({ "thunderbirdRequest": [] });
}

async function localyArchivePendingMessages(messages, account, currentPath)
{
  // What are we doing here if there is nothing to archive, just cancel
  if(!messages || messages.length == 0)
  {
    displayArchibaldMessage("");
    return;
  }

  archibaldLog("Archiving pending messages");
  const sourceFolderName = decodeLegacyFolderName(messages[0].folderName);
  let archiveCount = 0;

  // localFolderPath is like /Folder1/Sub1/Sub2
  const localFolderPath = `Archives/${sanitizeFolderName(account.name)}${currentPath.replace("INBOX","Courrier entrant")}`;

  // logLocalFolders();
  // We need to find the local folder by matching the true source folder path with the local folders names
  // because local folder ids might be abstracted by thunderbird in some cases
  // Like so: "/Archives/8f990b22/Courrier entrant"
  const targetFolder = await getLocalFolder(account, localFolderPath);

  // Move the selected messages
  for (const msg of messages)
  {
    let messages = await browser.messages.query({ headerMessageId: msg.messageId });
    if (messages.messages.length > 0)
    {
      // Find the numeric ID from messageId to move it
      let webExtMessageId = messages.messages[0].id;
      await browser.messages.move([webExtMessageId], targetFolder.id);
      archiveCount++;
    }
    else
      console.warn("Could not find message for messageId", hdr.messageId);
  }

  archibaldLog(`${archiveCount} pending messages archived from ${sourceFolderName}.`);
  return archiveCount;
}

async function selectedAccountChanged(accountId = null)
{
  // Reload folder list
  loadFolderListForSelectedAccount(accountId);

  // Restore form to load path
  restoreFormFromLocalStorage();
}

// Load folder list for the selected account (create it if necessary)
async function loadFolderListForSelectedAccount(accountId = null)
{
  if(accountId == null)
  {
    archibaldLog("Loading folder list for selected account.");
    const selectedMailbox = document.getElementById("mailboxDropdown").selectedOptions[0];
    accountId = JSON.parse(selectedMailbox.value).accountId;
  }
  else
    archibaldLog("Loading folder list for pending messages account.");



  try
  {
    const storedData = await browser.storage.local.get(accountId);

    if (storedData[accountId])
    {
      const folderNames = storedData[accountId].map(f => f.name).join(", ");
      archibaldLog(`Using stored folder list for account ${accountId}: ${folderNames}`);
    }
    else
    {
      archibaldLog(`No folder list found for ${accountId}, generating default list.`);
      await setDefaultFoldersForAccount(accountId);
    }
  }
  catch (err)
  {
    console.error("Error handling account selection:", err);
  }
}
// On load - This is already done when populating the dropbox
// document.addEventListener("DOMContentLoaded", async () => { await selectedAccountChanged(); });
// On account combobox change
document.getElementById("mailboxDropdown").addEventListener("change", selectedAccountChanged);


// Custom zip archive logic
async function downloadAsZip(folders, cutoffDate)
{
  const cutoffTimestamp = cutoffDate.getTime();
  const zip = new JSZip();
  let archiveCount = 0;

  for (const folder of folders)
  {
    const messages = await browser.messages.list(folder.id);
    const messagesToArchive = messages.messages.filter(msg => {
      return new Date(msg.date).getTime() < cutoffTimestamp;
    });

    for (const msg of messagesToArchive)
    {
      const msgDate = new Date(msg.date);
      const year = msgDate.getFullYear().toString();

      const full = await browser.messages.getFull(msg.id);
      const raw = full.raw;
      const subject = msg.subject || "message";
      const filename = `${sanitizeFilename(subject)} - ${msgDate.toISOString().split("T")[0]}.eml`;

      zip.folder(year).file(filename, raw);
      archiveCount++;
    }
  }

  // After all folders processed: save ZIP
  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(zipBlob);

  await browser.downloads.download({
    url,
    filename: "Archibald_Archive.zip",
    saveAs: true
  });

  URL.revokeObjectURL(url);
  archibaldLog(`${archiveCount} messages exported in one archive.`);
}

function useCustomLocalFolderChanged()
{
  const div = document.getElementById("localFolderPathDiv");
  const cb  = document.getElementById("useCustomLocalFolder");

  div.style.display = cb.checked ? "block" : "none";
}

/**
 *	sélection du chemin d'un nouveau dossier
 *
 *	@return	true si ok, false si erreur
 *
 */
async function selectNewLocalFolder()
{
  try
  {
    try
    {
      const paths = await messenger.archibaldApi.showFilePicker({
        mode: "openFolder",
        title: "Choisissez un dossier"
      });
      if (Array.isArray(paths) && paths.length > 0)
      {
        document.getElementById("localFolderPath").value = paths[0];
        archibaldLog("Chose new local folder path: " + paths[0]);
      }
      else
        console.warn("No folder selected or picker cancelled.");
    }
    catch (ex)
    {
      archibaldLog("Error in selectNewLocalFolder: "+ex.message);
    }
    } catch (ex) {
        alert(ex);
        return false;
    }

    return true;
}
function validateNewLocalPath(path)
{
    try {
        var bValid = true;
        var item = null;
        var iter = rep.directoryEntries;
        while (iter.hasMoreElements()) {
            bValid = false;
            item = iter.getNext();
            item = item.QueryInterface(Ci.nsIFile);
            if (item.isDirectory()) {
                bValid = eu.philoux.localfolder.ValidRepLocal(item);
                if (bValid) {
                    break;
                }
            } else if (item.isFile()) {
                var tab = item.leafName.split(".");
                if (tab.length) {
                    if ("msf" == tab[tab.length - 1]) {
                        bValid = true;
                        break;
                    }
                }
            }
        }
        return bValid;
    } catch (ex) {
        return false;
    }
    return false;
}

// Create a given account folder (and its parent folders if needed) in the profile local folder
async function createLocalFolder(folder, localAccountId, parentPath, storedFolders) {
  const isFolderChecked = storedFolders.some(f => f.name === folder.name);

  // Recursive function to check if any descendant folder is checked
  async function hasCheckedDescendants(currentFolder) {
    const subFolders = await browser.folders.getSubFolders(currentFolder.id);
    for (const sub of subFolders) {
      if (storedFolders.some(f => f.name === sub.name)) {
        return true;
      }
      if (await hasCheckedDescendants(sub)) {
        return true;
      }
    }
    return false;
  }

  const needsToBeCreated = isFolderChecked || await hasCheckedDescendants(folder);

  if (needsToBeCreated) {
    const sanitizedFolderName = sanitizeFolderName(folder.name);
    await browser.archibaldApi.createArchiveLocalFolder(localAccountId, sanitizedFolderName, parentPath);
    const newParentPath = parentPath + sanitizedFolderName + "/";
    const subFolders = await browser.folders.getSubFolders(folder.id);
    for (const sub of subFolders) {
      await createLocalFolder(sub, localAccountId, newParentPath, storedFolders);
    }
  }
}

function sanitizeFolderName(name)
{
  if (name.includes("/"))
    name = name.split(" - ")[0].replaceAll("/",".");

  return name;
}

async function logLocalFolders() {
  const accounts = await browser.accounts.list();
  const localAccount = accounts.find(acct => acct.type === "local");
  if (!localAccount) {
    console.error("Local Folders account not found.");
    return;
  }

  async function walkFolders(folder) {
    const subFolders = await browser.folders.getSubFolders(folder.id);
    for (const sub of subFolders) {
      await walkFolders(sub); // Recursively log subfolder paths
    }
  }

  const rootFolders = await browser.folders.getSubFolders(localAccount.id);
  for (const folder of rootFolders) {
    await walkFolders(folder);
  }
}

async function getLocalFolder(originalAccount, targetPath)
{
  let localAccount = await getAccountLocalAccount(originalAccount, true);

  if (!localAccount) {
    archibaldLog("Local account not found.");
    return null;
  }
  const localAccountRootFolders = await browser.folders.getSubFolders(localAccount.id);

  // Recursively search for the last matching folder
  const nameParts = targetPath.split("/").filter(Boolean);
  for (const rootFolder of localAccountRootFolders) {
    if(rootFolder.name = "Archives")
    {
      archibaldLog("Starting folder search recurence inside Archives local folder for "+decodeLegacyFolderName(targetPath));
      // Slicing the first nameParts wich is always "Archives" since we filtered it already
      const result = await findFolderByParts(rootFolder, sanitizeFolderName(nameParts.slice(1)));
      if (result)
        return result;
    }
  }

  async function findFolderByParts(currentFolder, remainingParts) {
    if (remainingParts.length === 0)
    {
      archibaldLog("Search finished, returning folder "+currentFolder.name);
      return currentFolder;
    }
    const subFolders = await browser.folders.getSubFolders(currentFolder.id);
    const nextPart = remainingParts[0];

    // Want to log subFolders ? Not so fast, use this:
    /*for (const folder of subFolders) {
      archibaldLog(JSON.stringify({
        name: folder.name,
        path: folder.path,
        id: folder.id,
        accountId: folder.accountId
      }));
    }*/

    const nextFolder = subFolders.find(f => f.name === decodeLegacyFolderName(nextPart));
    if (!nextFolder) {
      return null;
    }

    return await findFolderByParts(nextFolder, remainingParts.slice(1));
  }
}

// I don't know why, but folder names accents are in shambles, decode them...
function decodeLegacyFolderName(str)
{
  const legacyMap = {
    // Html codes
    '%20': ' ',

    // Lowercase
    '&AOa-': 'à',
    '&AOb-': 'á',
    '&AOc-': 'ç',
    '&AOd-': 'è',
    '&AOe-': 'é',
    '&AOf-': 'ê',
    '&AOg-': 'ë',
    '&AOh-': 'î',
    '&AOi-': 'ï',
    '&AOj-': 'ô',
    '&AOk-': 'é',
    '&AOl-': 'ù',
    '&AOm-': 'û',
    '&AOn-': 'ü',
    '&AOo-': 'ÿ',
    '&AOp-': 'œ',
    '&AOq-': 'æ',
    '&AOr-': 'ß',

    // Uppercase
    '&AOA-': 'À',
    '&AOB-': 'Á',
    '&AOC-': 'Ç',
    '&AOD-': 'È',
    '&AOE-': 'É',
    '&AOF-': 'Ê',
    '&AOG-': 'Ë',
    '&AOH-': 'Î',
    '&AOI-': 'Ï',
    '&AOJ-': 'Ô',
    '&AOK-': 'É',
    '&AOL-': 'Ù',
    '&AOM-': 'Û',
    '&AON-': 'Ü',
    '&AOO-': 'Ÿ',
    '&AOP-': 'Œ',
    '&AOQ-': 'Æ'
  };

  for (const [key, val] of Object.entries(legacyMap))
    str = str.split(key).join(val);

  return str;
}

async function removeCustomLocalFolder()
{
  archibaldLog("Local folder removal process started");

  // Retrieve selected account using selectedMailBox in form
  const selectedMailbox = mailboxDropdown.options[mailboxDropdown.selectedIndex];
  const selectedAccountId = JSON.parse(selectedMailbox.value).accountId;
  const accounts = await browser.accounts.list();
  const account = accounts.find(acc => acc.id === selectedAccountId);

  // Find the local account using the selected account
  const localAccount = await getAccountLocalAccount(account, false);

  // If we found a localAccount, and if it is not the default local account, remove it
  if(localAccount && !isLocalAccountDefault(localAccount))
  {
    archibaldLog("Found a non default local account to remove");
    // Remove the local account link to the selected mailbox
    await messenger.archibaldApi.removeCustomLocalFolder(localAccount.id);
    // Reset path on the form
    document.getElementById("localFolderPath").value = "";
    // Reset path in the local store
    resetAccountLocalFolderPath(localAccount.id);
    // Display success on the form
    displayArchibaldMessage("Le compte local a bien été supprimé du profil.");
    archibaldLog("Local account successfully removed");
  }
  else
  {
    // No account to remove found, let's simply clean up the form
    resetAccountLocalFolderPathByPath(document.getElementById("localFolderPath").value);
    document.getElementById("localFolderPath").value = "";
    archibaldLog("No custom local account to remove for the selected mailbox");
  }
}

// Returns true if the local account is the default local account
function isLocalAccountDefault(localAccount)
{
  if(localAccount.name.includes("Local - "))
    return false;
  return true;
}

// New code to archive by folder instead of by year
async function localyArchiveMessagesBeforeDate(sourceFolder, cutoffDate, account, localAccount)
{
  archibaldLog("Archiving messages from folder: " + sourceFolder.name + " before: " + cutoffDate);
  let archiveCount = 0;

  // Select messages that needs to be archived
  const cutoffTimestamp = cutoffDate.getTime();
  const messages = await browser.messages.list(sourceFolder.id);
  const messagesToArchive = messages.messages.filter(msg => {
    const msgDate = new Date(msg.date).getTime();
    return msgDate < cutoffTimestamp;
  });

  // localFolderPath is like /Folder1/Sub1/Sub2
  const localFolderPath = `Archives/${sanitizeFolderName(account.name)}${sourceFolder.path.replace("INBOX","Courrier entrant")}`;
  //logLocalFolders();
  // We need to find the local folder by matching the true source folder path with the local folders names
  // because local folder ids might be abstracted by thunderbird in some cases
  // Like so: "/Archives/8f990b22/Courrier entrant"
  const targetFolder = await getLocalFolder(account, localFolderPath);

  archibaldLog("Archiving to local folder: "+targetFolder.path);

  // Move the selected messages
  for (const msg of messagesToArchive) {
    await browser.messages.move([msg.id], targetFolder.id);
    archiveCount++;
  }

  archibaldLog(`${archiveCount} messages archived from ${sourceFolder.name}.`);
  return archiveCount;
}



async function createAccountLocalFolders(account, localAccount, pendingFolders)
{
  let storedData = null;
  if(!pendingFolders)
    storedData = await browser.storage.local.get(account.id);

  if (!account) {
      archibaldLog(`No account found for id ${account.id}`);
      return;
  }

  // Creating the account main folder under "Archives" (the default root)
  await browser.archibaldApi.createArchiveLocalFolder(localAccount.id, sanitizeFolderName(account.name), "");
  const parentPath = sanitizeFolderName(account.name)+"/";

  //accountTitle.textContent = `Compte : ${account.name}`;
  // Start populating from root folders
  const folders = await browser.folders.getSubFolders(account.id);
  // Do not create some default folders
  const blacklist = ["Archives", "Indésirables"];
  for (const folder of folders) {
    if (!blacklist.includes(folder.name)) {
      await createLocalFolder(folder, localAccount.id, parentPath, pendingFolders ? pendingFolders : storedData[account.id]);
    }
  }
}

// Archive folder messages before cutoffDate
async function archiveMessagesBeforeDate(folder, cutoffDate) {
  archibaldLog("Archiving folder: " + folder.name + " - before: " + cutoffDate);

  const cutoffTimestamp = cutoffDate.getTime();
  const messages = await browser.messages.list(folder.id);
  const messagesToArchive = messages.messages.filter(msg => {
    const msgDate = new Date(msg.date).getTime();
    return msgDate < cutoffTimestamp;
  });

  let archiveCount = 0;
  // Call thunderbird archiving logic
  for (const msg of messagesToArchive) {
    await browser.messages.archive([msg.id]);
    archiveCount++;
  }

  archibaldLog(`${archiveCount} messages archived from ${folder.name}.`);
  return archiveCount;
}

// Cleanup message name to store localy
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").substring(0, 100);
}

async function getOrCreateSubfolder(baseDirHandle, name) {
  return await baseDirHandle.getDirectoryHandle(name, { create: true });
}

// Create localAccount tree using Archibald form but don't archive
async function getAccountsReadyToArchive()
{
  // Get the selected account from the form
  const mailboxDropdown = document.getElementById("mailboxDropdown");
  const selectedMailbox = mailboxDropdown.options[mailboxDropdown.selectedIndex];
  const selectedAccountId = JSON.parse(selectedMailbox.value).accountId;
  const accounts = await browser.accounts.list();
  const account = accounts.find(acc => acc.id === selectedAccountId);
  if (!account)
    throw new Error("Account not found.");

  // Find the local account of this profile
  const localAccount = await getAccountLocalAccount(account, true);
  if(localAccount)
  {
    // Create folder hierarchy of selected account under found localAccount
    createAccountLocalFolders(account, localAccount);
  }
}

async function saveAndPrepare()
{
  // If the given path is different than the stored path, then we need to remove the previous local account first
  const currentPath = document.getElementById("localFolderPath").value;
  // Current account id
  const dropdown = document.getElementById("mailboxDropdown");
  const selectedOption = dropdown.options[dropdown.selectedIndex];
  const accountId = JSON.parse(selectedOption.value).accountId;
  // Per-account localFolderPath
  const { localFolderPaths } = await browser.storage.local.get("localFolderPaths");
  const oldPath = findPath(localFolderPaths || "", accountId);
  if(oldPath && oldPath != currentPath)
  {
    // Remove old account bind to setup new one
    await removeCustomLocalFolder();
    // removeCustomLocalFolder is removing the path, lets just reset it
    document.getElementById("localFolderPath").value = currentPath;
  }

  // Setup local folders
  await getAccountsReadyToArchive();

  // Save new form values
  await storeFormValues();
}

// Save button
document.getElementById("save").addEventListener("click", async () =>
{;
  // Disable form
  readyArchibaldWindow();

  // Save form, get local folders ready
  await saveAndPrepare();

  // Display confirm messages
  const useCustomLocalFolder = document.getElementById("useCustomLocalFolder").checked;
  if(!useCustomLocalFolder)
    displayArchibaldMessage("Paramètres sauvegardés.");
  else
    displayArchibaldMessage("Paramètres sauvegardés et compte local mis à jour.");

  // Enable form
  resetArchibaldWindow();
});

// Boutton Archiver
document.getElementById("archive").addEventListener("click", async () =>
{
  // Prepare window style, disable controls
  readyArchibaldWindow();

  // Save form, prepare local folders
  await saveAndPrepare();

  // Get the selected account from the form
  const mailboxDropdown = document.getElementById("mailboxDropdown");
  const selectedMailbox = mailboxDropdown.options[mailboxDropdown.selectedIndex];
  const selectedAccountId = JSON.parse(selectedMailbox.value).accountId;
  const accounts = await browser.accounts.list();
  const account = accounts.find(acc => acc.id === selectedAccountId);
  if (!account)
    throw new Error("Account not found.");

  //  Get the selected account folders and date from the form
  const storedFolders = await browser.storage.local.get(selectedAccountId);
  const storedFoldersForSelectedAccount = storedFolders[selectedAccountId];
  const selectedDate = document.getElementById("until");

  try
  {
    // Find the local account of this profile
    const localAccount = await getAccountLocalAccount(account, true);
    if(localAccount)
    {
      for (const folder of storedFoldersForSelectedAccount)
      {
        // For each folder, move the messages to it's corresponding folder
        // Move messages to their corresponding local folder
        archiveCount += await localyArchiveMessagesBeforeDate(folder, new Date(selectedDate.value), account, localAccount);
      }
    }
  }
  catch (error)
  {
    console.error("[Archibald] - An error occurred: "+error.message);
  }

  // Reset window style
  resetArchibaldWindow();
  setTimeout(() => {
    if(archiveCount > 0)
      displayArchibaldMessage("Archivage terminé ! " + archiveCount + " messages déplacés.");
    else
      displayArchibaldMessage("Aucun message à archiver.");

    archiveCount = 0;
  }, 200);
});

function displayArchibaldMessage(message)
{
  document.getElementById("statusLabel").textContent = message;
}

// Find a local account, given it's pretty name
async function getLocalAccountByName(name)
{
  const accounts = await browser.accounts.list();
  const localAccounts = accounts.filter(acct => acct.type === "local");
  for (const account of localAccounts) {
    if(account.name == name)
    {
      archibaldLog("Found matching local account: "+account.name);
      return account;
    }
  }
  return null;
}

// Return the local account corresponding to the given account
async function getAccountLocalAccount(originalAccount, forceCreation)
{
  try
  {
    const localAccountName = "Local - " + originalAccount.name;
    const useCustomLocalFolder = document.getElementById("useCustomLocalFolder").checked;
    if(!useCustomLocalFolder)
    {
      // Just use the default local account
      archibaldLog("Getting default local account");
      return getDefaultLocalAccount();
    }
    else
    {
      // Search the local account corresponding to the originalAccount name
      archibaldLog("Searching local account for: "+originalAccount.name);
      let localAccount = await getLocalAccountByName("Local - " + originalAccount.name);
      if(localAccount)
        return localAccount;

      // We didn't find it !
      archibaldLog("No local account found for this account");
      if(forceCreation)
      {
        archibaldLog("Let's create the custom local account then");
        const path = document.getElementById("localFolderPath").value;
        if(!path)
        {
          // Let's check if the User did everything right, just in case
          archibaldLog("User needs to choose a target folder");
          alert("Choisissez un dossier local");
          return null;
        }
        const newLocalAccountName = await messenger.archibaldApi.createCustomLocalFolder(originalAccount.id, path);
        archibaldLog("Created local account "+newLocalAccountName);

        // We created the account without issue, find it and return it
        localAccount = getLocalAccountByName(localAccountName);
        if(localAccount)
          return localAccount;
      }
      // We don't want to use the default local account, and we don't want to create a custom local account, so we get nothing
      return null;
    }
  }
  catch(ex)
  {
    archibaldLog("Error in getAccountLocalAccount: " + ex.message);
    return null;
  }
}

async function getDefaultLocalAccount()
{
  try
  {
    const accounts = await browser.accounts.list();
    const localAccounts = accounts.filter(acct => acct.type === "local");
    for (const account of localAccounts) {
      if(account.name == "Dossiers locaux")
      {
        archibaldLog("Returning localAccount: "+account.name);
        return account;
      }
    }
    archibaldLog("No default local account found.");
    return null;
  }
  catch(ex)
  {
    archibaldLog("Error in getDefaultLocalAccount: " + ex.message);
    return null;
  }
}

// These are helpers to generate a readable string of account,path|account,path to save / load in archibald form
function parsePairs(str) {
  return (str || "")
    .split("|")
    .filter(Boolean)
    .map(entry => {
      const [id, ...rest] = entry.split(",");
      return [id, rest.join(",")]; // keep commas inside path if any
    });
}
function upsertPair(str, id, path) {
  const pairs = parsePairs(str);
  let found = false;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === id) {
      pairs[i][1] = path;
      found = true;
      break;
    }
  }
  if (!found) pairs.push([id, path]);
  return pairs.map(([i, p]) => `${i},${p}`).join("|");
}
function findPath(str, id) {
  for (const [i, p] of parsePairs(str)) {
    if (i === id) return p;
  }
  return "";
}

// Coerce a found string to boolean, with a fallback default
function toBool(str, fallback = false) {
  if (str === "") return fallback;            // not found
  if (str == null) return fallback;
  const s = String(str).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// Store as "1" / "0" for compactness
function boolToToken(b) {
  return b ? "1" : "0";
}

async function resetAccountLocalFolderPath(accountId)
{
  // Get the current stored mapping string
  const stored = await browser.storage.local.get("localFolderPaths");
  const oldLocalFolderPaths = stored.localFolderPaths || "";

  // Parse and filter out the given accountId
  const newPairs = parsePairs(oldLocalFolderPaths).filter(([id]) => id !== accountId);

  // Rebuild the compact string "id,path|id,path|..."
  const newLocalFolderPaths = newPairs.map(([i, p]) => `${i},${p}`).join("|");

  // Store the new string
  await browser.storage.local.set({ localFolderPaths: newLocalFolderPaths });
}

async function resetAccountLocalFolderPathByPath(pathToRemove)
{
  if (!pathToRemove)
  {
    console.warn("resetAccountLocalFolderPathByPath: no path provided");
    return;
  }

  // Get the current stored mapping string
  const stored = await browser.storage.local.get("localFolderPaths");
  const oldLocalFolderPaths = stored.localFolderPaths || "";

  // Parse and filter out any pair whose path matches
  // (exact match — case-sensitive; change to .toLowerCase() if you want case-insensitive)
  const newPairs = parsePairs(oldLocalFolderPaths).filter(([id, p]) => p !== pathToRemove);

  // Rebuild the string
  const newLocalFolderPaths = newPairs.map(([i, p]) => `${i},${p}`).join("|");

  // Save updated data
  await browser.storage.local.set({ localFolderPaths: newLocalFolderPaths });
}

async function storeFormValues()
{
  // base values
  const days = document.getElementById("days").value;
  const useCustomLocalFolderChecked = document.getElementById("useCustomLocalFolder").checked;

  // Save legacy single-value keys (for backwards compatibility)
  await browser.storage.local.set({
    days,
    useCustomLocalFolder: useCustomLocalFolderChecked,
  });

  // Current account id
  const dropdown = document.getElementById("mailboxDropdown");
  const selectedOption = dropdown.options[dropdown.selectedIndex];
  const accountId = JSON.parse(selectedOption.value).accountId;

  // ----- per-account localFolderPath (existing behavior) -----
  const storedPaths = await browser.storage.local.get("localFolderPaths");
  const oldLocalFolderPaths = storedPaths.localFolderPaths || "";
  const localFolderPath = document.getElementById("localFolderPath").value;
  const newLocalFolderPaths = upsertPair(oldLocalFolderPaths, accountId, localFolderPath);
  await browser.storage.local.set({ localFolderPaths: newLocalFolderPaths });

  // ----- NEW: per-account checkbox state -----
  const storedFlags = await browser.storage.local.get("useCustomLocalFolderByAccount");
  const oldUseCustomLocalFolderByAccount = storedFlags.useCustomLocalFolderByAccount || ""; // "accountId,1|accountId,0|..."
  const newUseCustomLocalFolderByAccount = upsertPair(oldUseCustomLocalFolderByAccount, accountId, boolToToken(useCustomLocalFolderChecked));
  await browser.storage.local.set({ useCustomLocalFolderByAccount: newUseCustomLocalFolderByAccount });

  archibaldLog(
    "Saved form values with local paths: " + newLocalFolderPaths +
    " and per-account flags: " + newUseCustomLocalFolderByAccount
  );
}

// Restore the Archibald form from local storage
async function restoreFormFromLocalStorage() {
  try {
    // Current account id
    const dropdown = document.getElementById("mailboxDropdown");
    const selectedOption = dropdown.options[dropdown.selectedIndex];
    const accountId = JSON.parse(selectedOption.value).accountId;

    // Per-account localFolderPath
    const { localFolderPaths } = await browser.storage.local.get("localFolderPaths");
    const localFolderPath = findPath(localFolderPaths || "", accountId);
    document.getElementById("localFolderPath").value = localFolderPath ?? "";

    // Per-account checkbox flag
    const { useCustomLocalFolderByAccount } = await browser.storage.local.get("useCustomLocalFolderByAccount");
    const perAccountFlagToken = findPath(useCustomLocalFolderByAccount || "0", accountId);

    // Fallback to legacy single value if no per-account entry exists
    let useCustomLocalFolder = toBool(perAccountFlagToken, null);
    if (useCustomLocalFolder === null) {
      const legacy = await browser.storage.local.get("useCustomLocalFolder");
      useCustom = toBool(legacy.useCustomLocalFolder, false);
    }
    document.getElementById("useCustomLocalFolder").checked = !!useCustomLocalFolder;

    // Day count value (365 by default)
    const { days } = await browser.storage.local.get("days");
    document.getElementById("days").value = days ?? "365";

    // Show/hide local folder UI
    useCustomLocalFolderChanged();
  } catch (e) {
    archibaldLog("restoreFormFromLocalStorage failed: " + (e && e.message ? e.message : e));
  }
}

// Prepare window for archiving
function readyArchibaldWindow()
{
  const progressContainer = document.getElementById("progressContainer");
  progressContainer.style.display = "block";
  document.getElementById("save").disabled = true;
  document.getElementById("archive").disabled = true;
  document.getElementById("cancel").disabled = true;
  document.getElementById("statusLabel").textContent = "Archivage en cours...";
}

// Reset window state
function resetArchibaldWindow()
{
  // Hide Progress Bar and enable buttons
  document.getElementById("progressContainer").style.display = "none";
  document.getElementById("save").disabled = false;
  document.getElementById("archive").disabled = false;
  document.getElementById("cancel").disabled = false;
}

// Close the window on cancel
document.getElementById("cancel").addEventListener("click", async () => {
    //await storeFormValues();
    archibaldLog("Closing main window");
    window.close();
    pendingMode = false;
});

function archibaldLog(consoleString)
{
  console.log("[Archibald] - "+JSON.stringify(consoleString));
  //document.getElementById("statusLabel").textContent = JSON.stringify(consoleString);
}

async function setDefaultFoldersForAccount(accountId)
{
  const account = await browser.accounts.get(accountId);
  archibaldLog("Setting default folders for account: "+accountId);
  const folders = await browser.folders.getSubFolders(accountId);

  // Start to collect folders from the selected account
  const selectedFolders = [];
  for (const folder of folders)
    await collect(folder);

  async function collect(folder)
  {
    const blacklist = ["Archives", "Indésirables"];
    const greylist = ["Corbeille", "Brouillons", "Modèles", "Éléments envoyés"];

    if (!blacklist.includes(folder.name) && !greylist.includes(folder.name))
    {
      archibaldLog("Collecting default folder:", folder.name);

      selectedFolders.push({
        name: folder.name,
        path: folder.path,
        id: folder.id,
        accountId: folder.accountId,
      });

      // Fetch subfolders explicitly
      const subFolders = await messenger.folders.getSubFolders(folder.id);

      for (const sub of subFolders) {
        await collect(sub); // recurse into subfolders
      }
    }
  }

  const filePath = "defaults/"+ accountId +".json";
  await browser.storage.local.set({ [accountId]: selectedFolders });
  archibaldLog("Saved default folders for account: "+accountId);
}

// Open folder list iframe
document.getElementById("foldersButton").addEventListener("click", async () => {
  // This is old code to open the html page in a separate window
  /*const width = 500;
  const height = 500;

  // Get the current screen dimensions
  const screenInfo = await browser.windows.getCurrent();
  const left = Math.round(screenInfo.left + (screenInfo.width - width) / 2);
  const top = Math.round(screenInfo.top + (screenInfo.height - height) / 2);

  await browser.windows.create({
    url: `./archibaldFolders.html?accountId=${encodeURIComponent(accountId)}`,
    type: "popup",
    width: width,
    height: height
  });*/

  // We now use an iFrame instead of a separate window to easy the flow
  const dropdown = document.getElementById("mailboxDropdown");
  const selectedOption = dropdown.options[dropdown.selectedIndex];
  const accountId = JSON.parse(selectedOption.value).accountId;

  document.getElementById("foldersButton").disabled = true;
  document.getElementById("folderSelectionFrame").src = `./archibaldFolders.html?accountId=${encodeURIComponent(accountId)}`;
  document.getElementById("folderSelectionDiv").style.display = "block";
});

// This catches the request from the iframe to hide it
function hideArchibaldFolders()
{
  document.getElementById("folderSelectionDiv").style.display = "none";
  document.getElementById("foldersButton").disabled = false;
}

window.addEventListener("message", (event) => {
  switch (event.data.action)
  {
    case "setArchibaldFoldersHeight":
      setArchibaldFolderHeight(event.data.height);
      break;
    case "closeArchibaldFolders":
      hideArchibaldFolders();
      break;
    default:
      archibaldLog("Warning: Used default case in 'addEventListener' with action "+event.data.action);
      break;
  }
});

function setArchibaldFolderHeight()
{
  const iframe = document.getElementById("folderSelectionFrame");
  const newHeight = event.data.height;
  // Apply height but respect your max height
  iframe.style.height = Math.min(newHeight, 400) + "px";

  // Also make sure the container div is visible
  document.getElementById("folderSelectionDiv").style.display = "block";
}