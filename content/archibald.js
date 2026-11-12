let archiveCount = 0;
let pendingMode = false;

// List all available accounts
async function populateInboxDropdown()
{
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

// Set the extension version dynamically from manifest.json
function displayExtensionVersion()
{
  const versionLabel = document.getElementById("versionLabel");
  if (versionLabel)
  {
    const manifest = browser.runtime.getManifest();
    versionLabel.textContent = `v${manifest.version}`;
  }
}
displayExtensionVersion();

let isProcessingPending = false;

// Check and process any pending messages from Thunderbird core
async function checkAndProcessPendingMessages()
{
  if (isProcessingPending)
    return;

  try
  {
    const { thunderbirdRequest } = await browser.storage.local.get("thunderbirdRequest");
    if (thunderbirdRequest && Array.isArray(thunderbirdRequest.messages) && thunderbirdRequest.messages.length)
    {
      archibaldLog("Pending data received from background.js (tab active):");
      thunderbirdRequest.messages.forEach((msg, index) => {
        archibaldLog(`Message[${index}]: id=${msg.messageId}, folderURI=${msg.folderURI}, folderName=${msg.folderName}, accountId=${msg.accountId}`);
      });

      const messagesToProcess = [...thunderbirdRequest.messages];
      pendingMode = true;

      // Clear immediately to prevent duplicate runs from concurrent listeners
      await browser.storage.local.set({ "thunderbirdRequest": [] });

      await processPendingMessages(messagesToProcess);
    }
  }
  catch (ex)
  {
    archibaldLog("Error checking pending messages: " + ex.message);
  }
}

// Dynamicly adjust date and day counts
document.addEventListener("DOMContentLoaded", async () => {
  // Create listeners for form actions
  document.getElementById("btSelectNewLocalFolder").addEventListener("click", () => {selectNewLocalFolder();});
  document.getElementById("useCustomLocalFolder").addEventListener("change", () => {useCustomLocalFolderChanged();});
  document.getElementById("btRemoveCustomLocalFolder").addEventListener("click", () => {removeCustomLocalFolder();});
  document.getElementById("showWindowOnManualArchive").addEventListener("change", async (e) => {
    await browser.storage.local.set({ showWindowOnManualArchive: e.target.checked });
  });

  const daysInput = document.getElementById("days");
  const dateInput = document.getElementById("until");

  // Update date when days change
  daysInput.addEventListener("input", updateDateFromDays);

  // Update days when date changes
  dateInput.addEventListener("input", updateDaysFromDate);

  await restoreFormFromLocalStorage();

  // Process any pending request on load
  await checkAndProcessPendingMessages();
});

// If Archibald tab is ALREADY OPEN, listen for storage changes, runtime messages and focus events!
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.thunderbirdRequest) {
    const val = changes.thunderbirdRequest.newValue;
    if (val && Array.isArray(val.messages) && val.messages.length > 0) {
      archibaldLog("Storage changed with pending messages");
      checkAndProcessPendingMessages();
    }
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message && message.action === "processPendingMessages") {
    archibaldLog("Runtime message received to process pending messages");
    checkAndProcessPendingMessages();
  } else if (message && message.action === "manualArchiveCompleted") {
    archibaldLog("Manual archive completed in background: " + message.count + " messages");
    displayArchibaldMessage(`Archivage manuel terminé ! ${message.count} message(s) déplacé(s).`);
  }
});

window.addEventListener("focus", () => {
  checkAndProcessPendingMessages();
});

async function processPendingMessages(messages)
{
  if (!messages || messages.length === 0)
  {
    displayArchibaldMessage("");
    return;
  }

  isProcessingPending = true;
  try
  {
    readyArchibaldWindow();
    const archiveCount = await processArchiveMessages(messages);
    setTimeout(() => {
      resetArchibaldWindow();
      if (archiveCount > 0)
      {
        document.getElementById("statusLabel").textContent = "Archivage terminé ! " + archiveCount + " messages déplacés.";
      }
      else
      {
        document.getElementById("statusLabel").textContent = "Aucun message à archiver.";
      }
    }, 200);

    await browser.storage.local.set({ "thunderbirdRequest": [] });
  }
  catch (err)
  {
    archibaldLog("Error in processPendingMessages: " + (err?.message || err));
    console.error("Error in processPendingMessages:", err);
    resetArchibaldWindow();
  }
  finally
  {
    isProcessingPending = false;
  }
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
    const paths = await messenger.archibaldApi.showFilePicker({
      mode: "openFolder",
      title: "Choisissez un dossier"
    });
    if (Array.isArray(paths) && paths.length > 0)
    {
      const selectedPath = paths[0];

      // Check if selected folder conflicts with existing accounts (especially default Local Folders)
      const conflict = await messenger.archibaldApi.checkLocalFolderConflict(selectedPath);
      if (conflict && conflict.isConflict)
      {
        if (conflict.isDefaultLocal)
        {
          alert("Ce dossier est déjà utilisé par Thunderbird pour les Dossiers locaux. Pour utiliser les Dossiers locaux, désactivez simplement l'option \"Dossier personnalisé\".");
        }
        else
        {
          alert(`Ce dossier est déjà utilisé par le compte « ${conflict.accountName || "existant"} ». Veuillez en choisir un autre.`);
        }
        return false;
      }

      document.getElementById("localFolderPath").value = selectedPath;
      archibaldLog("Chose new local folder path: " + selectedPath);
    }
    else
    {
      console.warn("No folder selected or picker cancelled.");
    }
  }
  catch (ex)
  {
    archibaldLog("Error in selectNewLocalFolder: " + ex.message);
    alert(ex.message || ex);
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

  // In the end, remove also the stored string value for the localFolder field:
  const storedPaths = await browser.storage.local.get("localFolderPaths");
  const oldLocalFolderPaths = storedPaths.localFolderPaths || "";
  const localFolderPath = document.getElementById("localFolderPath").value;
  const newLocalFolderPaths = upsertPair(oldLocalFolderPaths, selectedAccountId, localFolderPath);
  await browser.storage.local.set({ localFolderPaths: newLocalFolderPaths });
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

  // Retrieve messages from the folder (try MailFolder object first, then folder.id)
  let page = null;
  try {
    page = await browser.messages.list(sourceFolder);
  } catch (e1) {
    try {
      page = await browser.messages.list(sourceFolder.id);
    } catch (e2) {
      archibaldLog(`Error listing messages from folder ${sourceFolder.name}: ${e2?.message || e2}`);
    }
  }

  // Handle pagination to get all messages in the folder
  const allMessages = [];
  if (page && Array.isArray(page.messages)) {
    allMessages.push(...page.messages);
    while (page.id) {
      try {
        page = await browser.messages.continueList(page.id);
        if (page && Array.isArray(page.messages)) {
          allMessages.push(...page.messages);
        } else {
          break;
        }
      } catch (eCont) {
        archibaldLog(`Error during pagination for ${sourceFolder.name}: ${eCont?.message || eCont}`);
        break;
      }
    }
  }

  archibaldLog(`Retrieved ${allMessages.length} total messages in folder "${sourceFolder.name}".`);

  // Select messages that need to be archived
  const cutoffTimestamp = cutoffDate.getTime();
  const messagesToArchive = allMessages.filter(msg => {
    const msgDate = new Date(msg.date).getTime();
    const isEligible = msgDate < cutoffTimestamp;
    archibaldLog(` - Msg [${msg.id}] "${msg.subject || '(sans objet)'}" date: ${new Date(msg.date).toLocaleString()} (${msgDate}) -> eligible: ${isEligible}`);
    return isEligible;
  });

  archibaldLog(`${messagesToArchive.length} messages eligible for archiving in "${sourceFolder.name}".`);

  if (messagesToArchive.length === 0)
  {
    archibaldLog(`0 messages archived from ${sourceFolder.name}.`);
    return 0;
  }

  // localFolderPath is like /Folder1/Sub1/Sub2
  const frenchSourcePath = translateFolderPathToFrench(sourceFolder.path, sourceFolder.name);
  const localFolderPath = `Archives/${sanitizeFolderName(account.name)}${frenchSourcePath}`;
  //logLocalFolders();
  // We need to find the local folder by matching the true source folder path with the local folders names
  // because local folder ids might be abstracted by thunderbird in some cases
  // Like so: "/Archives/8f990b22/Courrier entrant"
  let targetFolder = await getLocalFolder(account, localFolderPath);
  if (!targetFolder)
  {
    archibaldLog(`Target local folder not found: ${localFolderPath}, creating it now...`);
    const resolvedLocalAccount = localAccount || await getAccountLocalAccount(account, true);
    if (resolvedLocalAccount)
    {
      const parts = localFolderPath.split("/").filter(Boolean);
      let parentPath = "";
      for (let i = 1; i < parts.length; i++)
      {
        const partName = sanitizeFolderName(getFrenchFolderName(parts[i]) || parts[i]);
        await browser.archibaldApi.createArchiveLocalFolder(resolvedLocalAccount.id, partName, parentPath);
        parentPath += partName + "/";
      }
      targetFolder = await getLocalFolder(account, localFolderPath);
    }
  }
  if (!targetFolder)
  {
    archibaldLog("Target local folder not found: " + localFolderPath);
    throw new Error(`Dossier local cible introuvable pour "${localFolderPath}". Veuillez d'abord cliquer sur Enregistrer pour créer la structure locale.`);
  }

  archibaldLog("Archiving to local folder: "+targetFolder.path);

  // Move the selected messages
  for (const msg of messagesToArchive)
  {
    await browser.messages.move([msg.id], targetFolder.id);
    archiveCount++;
  }

  archibaldLog(`${archiveCount} messages archived from ${sourceFolder.name}.`);
  return archiveCount;
}





// Archive folder messages before cutoffDate
async function archiveMessagesBeforeDate(folder, cutoffDate)
{
  archibaldLog("Archiving folder: " + folder.name + " - before: " + cutoffDate);

  const cutoffTimestamp = cutoffDate.getTime();
  const messages = await browser.messages.list(folder.id);
  const messagesToArchive = messages.messages.filter(msg => {
    const msgDate = new Date(msg.date).getTime();
    return msgDate < cutoffTimestamp;
  });

  let archiveCount = 0;
  // Call thunderbird archiving logic
  for (const msg of messagesToArchive)
  {
    await browser.messages.archive([msg.id]);
    archiveCount++;
  }

  archibaldLog(`${archiveCount} messages archived from ${folder.name}.`);
  return archiveCount;
}

// Cleanup message name to store localy
function sanitizeFilename(name)
{
  return name.replace(/[\\/:*?"<>|]/g, "_").substring(0, 100);
}

async function getOrCreateSubfolder(baseDirHandle, name)
{
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
    await createAccountLocalFolders(account, localAccount);
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
{
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
  let cutoffDate;
  if (selectedDate && selectedDate.value)
  {
    const [y, m, d] = selectedDate.value.split("-").map(Number);
    cutoffDate = new Date(y, m - 1, d, 23, 59, 59, 999);
  }
  else
  {
    cutoffDate = new Date();
  }

  try
  {
    // Find the local account of this profile
    const localAccount = await getAccountLocalAccount(account, true);
    if(localAccount)
    {
      for (const folder of storedFoldersForSelectedAccount)
      {
        try
        {
          // For each folder, move the messages to it's corresponding folder
          // Move messages to their corresponding local folder
          archiveCount += await localyArchiveMessagesBeforeDate(folder, cutoffDate, account, localAccount);
        }
        catch (folderError)
        {
          console.error(`[Archibald] - An error occurred on folder "${folder?.name}": ` + (folderError?.message || folderError));
          archibaldLog(`Error archiving folder "${folder?.name}": ` + (folderError?.message || folderError));
        }
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
  const showWindowOnManualArchive = document.getElementById("showWindowOnManualArchive")?.checked || false;

  // Save legacy single-value keys (for backwards compatibility)
  await browser.storage.local.set({
    days,
    useCustomLocalFolder: useCustomLocalFolderChecked,
    showWindowOnManualArchive: !!showWindowOnManualArchive,
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

// Synchronize the 'until' date input from the 'days' number input
function updateDateFromDays()
{
  const daysInput = document.getElementById("days");
  const dateInput = document.getElementById("until");
  if (!daysInput || !dateInput)
    return;

  const daysVal = parseInt(daysInput.value, 10);
  if (!isNaN(daysVal))
  {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - daysVal);
    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, "0");
    const day = String(targetDate.getDate()).padStart(2, "0");
    dateInput.value = `${year}-${month}-${day}`;
  }
}

// Synchronize the 'days' number input from the 'until' date input
function updateDaysFromDate()
{
  const daysInput = document.getElementById("days");
  const dateInput = document.getElementById("until");
  if (!daysInput || !dateInput)
    return;

  if (dateInput.value)
  {
    const [y, m, d] = dateInput.value.split("-").map(Number);
    const selected = new Date(y, m - 1, d);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    selected.setHours(0, 0, 0, 0);
    const diffTime = now.getTime() - selected.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    daysInput.value = Math.max(0, diffDays);
  }
}

// Restore the Archibald form from local storage
async function restoreFormFromLocalStorage()
{
  try
  {
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
    if (useCustomLocalFolder === null)
    {
      const legacy = await browser.storage.local.get("useCustomLocalFolder");
      useCustom = toBool(legacy.useCustomLocalFolder, false);
    }
    document.getElementById("useCustomLocalFolder").checked = !!useCustomLocalFolder;

    // Show window on manual archive checkbox (default: false)
    const { showWindowOnManualArchive } = await browser.storage.local.get("showWindowOnManualArchive");
    const showWindowCb = document.getElementById("showWindowOnManualArchive");
    if (showWindowCb) {
      showWindowCb.checked = !!showWindowOnManualArchive;
    }

    // Day count value (365 by default)
    const { days } = await browser.storage.local.get("days");
    document.getElementById("days").value = days ?? "365";

    // Synchronize the 'until' date with the restored 'days' value
    updateDateFromDays();

    // Show/hide local folder UI
    useCustomLocalFolderChanged();
  }
  catch (e)
  {
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
  document.getElementById("statusLabel").textContent = "Traitement en cours...";
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