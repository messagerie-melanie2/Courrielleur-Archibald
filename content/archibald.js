let archiveCount = 0;
let pendingMode = false;

// Prevent user from resizing the window
/*function enforceFixedSizeOnResize() {
    window.addEventListener("resize", async () => {
      const win = await browser.windows.getCurrent();
      if (win.width !== WIDTH || win.height !== HEIGHT) {
        await browser.windows.update(win.id, {
          width: WIDTH,
          height: HEIGHT
        });
      }
    });

    // Set the initial size on load
    browser.windows.getCurrent().then(win => {
      browser.windows.update(win.id, {
        width: WIDTH,
        height: HEIGHT
      });
    });
}
document.addEventListener("DOMContentLoaded", enforceFixedSizeOnResize);*/

// List all available accounts
async function populateInboxDropdown() {
  /*const dropdown = document.getElementById("mailboxDropdown");
  const accounts = await browser.accounts.list();

  for (const account of accounts) {
    for (const folder of account.folders) {
      if (folder.type === "inbox") {
        const option = document.createElement("option");
        option.value = JSON.stringify({
          accountId: account.id,
          folderPath: folder.path
        });
        option.textContent = `${account.name} – ${folder.name}`;
        dropdown.appendChild(option);
      }
    }
  }
  loadFolderListForSelectedAccount();*/

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

  loadFolderListForSelectedAccount();
}
//document.addEventListener("DOMContentLoaded", populateInboxDropdown);
populateInboxDropdown();

// Dynamicly adjust date and day counts
document.addEventListener("DOMContentLoaded", async () => {
  let pendingMessages = null;
  try {
    const response = await chrome.runtime.sendMessage({ type: "getSafeMessages" });
    console.log("[Archibald] - Additional data recieved from background.js:");
    response.messages.forEach((msg, index) => {
      archibaldLog(`Message[${index}]:`);
      console.log("[Archibald] -   id: " + msg.messageId);
      console.log("[Archibald] -   folderURI: " + msg.folderURI);
      console.log("[Archibald] -   folderName: " + msg.folderName);
      console.log("[Archibald] -   accountId: " + msg.accountId);
    });
    pendingMessages = response.messages;
    pendingMode = true;
  }
  catch (ex) {
    console.log("[Archibald] - No additional data. Archibald likely opened through user action.");
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
}

async function localyArchivePendingMessages(messages, account, currentPath) {
  console.log("[Archibald] - Archiving pending messages");
  const sourceFolderName = decodeLegacyFolderName(messages[0].folderName);
  const progressBar = document.getElementById("progressBar");
  progressBar.max = messages.length;
  progressBar.value = 0;
  let archiveCount = 0;

  // localFolderPath is like /Folder1/Sub1/Sub2
  const localFolderPath = `Archives/${sanitizeFolderName(account.name)}${currentPath.replace("INBOX","Courrier entrant")}`;

  // logLocalFolders();
  // We need to find the local folder by matching the true source folder path with the local folders names
  // because local folder ids might be abstracted by thunderbird in some cases
  // Like so: "/Archives/8f990b22/Courrier entrant"
  const targetFolder = await getLocalFolder(localFolderPath);

  // Move the selected messages
  for (const msg of messages) {

    let messages = await browser.messages.query({ headerMessageId: msg.messageId });
    if (messages.messages.length > 0) {
      // Find the numeric ID from messageId to move it
      let webExtMessageId = messages.messages[0].id;
      await browser.messages.move([webExtMessageId], targetFolder.id);
      progressBar.value += 1;
      archiveCount++;
    }
    else
      console.warn("Could not find message for messageId", hdr.messageId);
  }

  archibaldLog(`${archiveCount} pending messages archived from ${sourceFolderName}.`);
  return archiveCount;
}

// Load folder list for the selected account (create it if necessary)
async function loadFolderListForSelectedAccount(accountId = null) {
  if(accountId == null)
  {
    console.log("[Archibald] - Loading folder list for selected account.");
    const selectedMailbox = document.getElementById("mailboxDropdown").selectedOptions[0];
    accountId = JSON.parse(selectedMailbox.value).accountId;
  }
  else
    console.log("[Archibald] - Loading folder list for pending messages account.");



  try {
    const storedData = await browser.storage.local.get(accountId);

    if (storedData[accountId]) {
      const folderNames = storedData[accountId].map(f => f.name).join(", ");
      archibaldLog(`Using stored folder list for account ${accountId}: ${folderNames}`);
    } else {
      archibaldLog(`No folder list found for ${accountId}, generating default list.`);
      await setDefaultFoldersForAccount(accountId);
    }
  } catch (err) {
    console.error("Error handling account selection:", err);
  }
}
// On load - This is already done when populating the dropbox
// document.addEventListener("DOMContentLoaded", async () => { await loadFolderListForSelectedAccount(); });
// On account combobox change
document.getElementById("mailboxDropdown").addEventListener("change", loadFolderListForSelectedAccount);


// Custom zip archive logic
async function downloadAsZip(folders, cutoffDate) {
  const cutoffTimestamp = cutoffDate.getTime();
  const zip = new JSZip();
  let archiveCount = 0;

  for (const folder of folders) {
    const messages = await browser.messages.list(folder.id);
    const messagesToArchive = messages.messages.filter(msg => {
      return new Date(msg.date).getTime() < cutoffTimestamp;
    });

    for (const msg of messagesToArchive) {
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

async function getLocalFolder(targetPath) {
  const accounts = await browser.accounts.list();
  const localAccount = accounts.find(acct => acct.type === "local");
  if (!localAccount) {
    console.error("[Archibald] - Local Folders account not found.");
    return null;
  }
  const localAccountRootFolders = await browser.folders.getSubFolders(localAccount.id);

  // Recursively search for the last matching folder
  const nameParts = targetPath.split("/").filter(Boolean);
  for (const rootFolder of localAccountRootFolders) {
    if(rootFolder.name = "Archives")
    {
      console.log("[Archibald] - Starting folder search recurence inside Archives local folder for "+decodeLegacyFolderName(targetPath));
      // Slicing the first nameParts wich is always "Archives" since we filtered it already
      const result = await findFolderByParts(rootFolder, sanitizeFolderName(nameParts.slice(1)));
      if (result)
        return result;
    }
  }

  async function findFolderByParts(currentFolder, remainingParts) {
    if (remainingParts.length === 0)
    {
      console.log("[Archibald] - Search finished, returning folder "+currentFolder.name);
      return currentFolder;
    }
    const subFolders = await browser.folders.getSubFolders(currentFolder.id);
    const nextPart = remainingParts[0];

    // Want to log subFolders ? Not so fast, use this:
    /*for (const folder of subFolders) {
      console.log(JSON.stringify({
        name: folder.name,
        path: folder.path,
        id: folder.id,
        accountId: folder.accountId
      }));
    }*/

    const nextFolder = subFolders.find(f => f.name === decodeLegacyFolderName(nextPart));
    if (!nextFolder) {
      console.warn(`Folder not found`);
      return null;
    }

    return await findFolderByParts(nextFolder, remainingParts.slice(1));
  }
}

// I don't know why, but folder names accents are in shambles, decode them...
function decodeLegacyFolderName(str) {
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

  for (const [key, val] of Object.entries(legacyMap)) {
    str = str.split(key).join(val);
  }
  return str;
}

// New code to archive by folder instead of by year
async function localyArchiveMessagesBeforeDate(sourceFolder, cutoffDate, account, localAccount) {
  console.log("[Archibald] - Archiving messages from folder: " + sourceFolder.name + " before: " + cutoffDate);
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
  const targetFolder = await getLocalFolder(localFolderPath);

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

// Old code archiving by year
// Archive messages as .eml files in year-based subfolders inside basePath
async function yearlyArchiveMessagesBeforeDate(folder, cutoffDate) {
  console.log("[Archibald] - Localy archiving folder: " + folder.name + " - before: " + cutoffDate);

  const cutoffTimestamp = cutoffDate.getTime();
  const messages = await browser.messages.list(folder.id);
  const messagesToArchive = messages.messages.filter(msg => {
    const msgDate = new Date(msg.date).getTime();
    return msgDate < cutoffTimestamp;
  });

  let archiveCount = 0;
  const accounts = await browser.accounts.list();
  const localAccount = accounts.find(acct => acct.type === "local");
  if (!localAccount)
      throw new Error("Local Folders account not found.");
  for (const msg of messagesToArchive) {
    const messageYear = new Date(msg.date).getFullYear().toString();

    // Use archibaldApi experimental to create local folder
    const yearFolderUri = await browser.archibaldApi.createArchiveLocalFolder(localAccount.id, messageYear);

    // Move the message to the right local folder
    await browser.messages.move([msg.id], yearFolderUri);
    archiveCount++;
  }

  archibaldLog(`${archiveCount} messages archived from ${folder.name}.`);
  return archiveCount;
}

// Archive folder messages before cutoffDate
async function archiveMessagesBeforeDate(folder, cutoffDate) {
  console.log("[Archibald] - Archiving folder: " + folder.name + " - before: " + cutoffDate);

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

// Ok button
document.getElementById("ok").addEventListener("click", async () => {
  if(pendingMode)
  {
    document.getElementById("cancel").click();
    return;
  }
  // Selected Account
  const mailboxDropdown = document.getElementById("mailboxDropdown");
  const selectedMailbox = mailboxDropdown.options[mailboxDropdown.selectedIndex];
  const selectedAccountId = JSON.parse(selectedMailbox.value).accountId;
  const accounts = await browser.accounts.list();
  const account = accounts.find(acc => acc.id === selectedAccountId);
  if (!account)
    throw new Error("Account not found.");

  // Selected Folders and date
  const storedFolders = await browser.storage.local.get(selectedAccountId);
  const storedFoldersForSelectedAccount = storedFolders[selectedAccountId];
  const selectedDate = document.getElementById("until");

  // Prepare window style
  const progressBar = document.getElementById("progressBar");
  readyArchibaldWindow();

  try {
    storeFormValues();
    if(true)//document.getElementById("local").checked)
    {
      // Simply download a zip folder
      //downloadAsZip(storedFoldersForSelectedAccount, new Date(selectedDate.value));

      // Find the local account of this profile
      const localAccount = accounts.find(acct => acct.type === "local");
      if (!localAccount)
        throw new Error("Local account not found.");

      // Create folder hierarchy of selected account under found localAccount
      createAccountLocalFolders(account, localAccount);

      let i = 0;
      for (const folder of storedFoldersForSelectedAccount) {
        // For each folder, move the messages to it's corresponding folder
        // Move messages to their corresponding local folder
        archiveCount += await localyArchiveMessagesBeforeDate(folder, new Date(selectedDate.value), account, localAccount);

        // Update progress bar
        const progress = Math.round(((i + 1) / storedFoldersForSelectedAccount.length) * 100);
        progressBar.value = progress;
        i++;
      }
    }
    else
    {
      // Archive using Thunderbird default logic
      let i = 0;
      for (const folder of storedFoldersForSelectedAccount) {
        archiveCount += await archiveMessagesBeforeDate(folder, new Date(selectedDate.value));

        // Update progress bar
        const progress = Math.round(((i + 1) / storedFoldersForSelectedAccount.length) * 100);
        progressBar.value = progress;
        i++;
      }
    }
  }
  catch (error) {
    console.error("An error occurred: "+error.message);
  }

  // Reset window style
  resetArchibaldWindow();
  setTimeout(() => {
    if(archiveCount > 0)
      document.getElementById("statusLabel").textContent = "Archivage terminé ! " + archiveCount + " messages déplacés.";
    else
      document.getElementById("statusLabel").textContent = "Aucun message à archiver.";
    archiveCount = 0;
  }, 200);
});

// Store form values in local storage
function storeFormValues()
{
  browser.storage.local.set({ ["days"]: document.getElementById("days").value });
  //browser.storage.local.set({ ["local"]: document.getElementById("local").checked });
}

// Restore the Archibald form from local storage
async function restoreFormFromLocalStorage()
{
  try
  {
    // Local archiving checkbox (checked by default)
    const local = true;//(await browser.storage.local.get("local")).local;
    //document.getElementById("local").checked = (local === undefined || local === null) ? true : !!local;

    // Day count value (365 by default)
    const days = (await browser.storage.local.get("days")).days;
    document.getElementById("days").value = days ?? "365";
  }
  catch
  {

  }
}

// Prepare window for archiving
function readyArchibaldWindow()
{
  // Show Progress Bar later if needed. Disable buttons
  const progressContainer = document.getElementById("progressContainer");
  progressContainer.style.display = "block";
  document.getElementById("ok").disabled = true;
  document.getElementById("cancel").disabled = true;
  document.getElementById("statusLabel").textContent = "Archivage en cours...";
}

// Reset window state
function resetArchibaldWindow()
{
  // Hide Progress Bar and enable buttons
  document.getElementById("progressContainer").style.display = "none";
  document.getElementById("progressBar").value = 0;
  document.getElementById("ok").disabled = false;
  document.getElementById("cancel").disabled = false;

  if(pendingMode)
    document.getElementById("ok").textContent = "Ok";
}

// Close the window on cancel
document.getElementById("cancel").addEventListener("click", async () => {
    storeFormValues();
    console.log("[Archibald] - Closing main window");
    window.close();
    pendingMode = false;
});

function archibaldLog(consoleString)
{
  console.log("[Archibald] - "+JSON.stringify(consoleString));
}

async function setDefaultFoldersForAccount(accountId) {
  const account = await browser.accounts.get(accountId);
  console.log("[Archibald] - Setting default folders for account: "+accountId);
  const folders = await browser.folders.getSubFolders(accountId);

  // Start to collect folders from the selected account
  const selectedFolders = [];
  for (const folder of folders)
    await collect(folder);

  async function collect(folder) {
    const blacklist = ["Archives", "Indésirables"];
    const greylist = ["Corbeille", "Brouillons", "Modèles", "Éléments envoyés"];

    if (!blacklist.includes(folder.name) && !greylist.includes(folder.name)) {
      console.log("[Archibald] - Collecting default folder:", folder.name);

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
  console.log("[Archibald] - Saved default folders for account: "+accountId);
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
      console.log("[Archibald] - Warning: Used default case in 'addEventListener' with action "+event.data.action);
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