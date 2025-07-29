let WIDTH = 500;
let HEIGHT = 400;
let archiveCount = 0;

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
});

// Load folder list for the selected account (create it if necessary)
async function loadFolderListForSelectedAccount() {
  archibaldLog("Loading folder list for selected account.");
  const selectedMailbox = document.getElementById("mailboxDropdown").selectedOptions[0];
  const accountId = JSON.parse(selectedMailbox.value).accountId;

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

async function createLocalFolder(folder, localAccountId, parentPath, storedFolders) {
  // Ne pas créer le dossiers non cochés
  if(storedFolders.some(f => f.name === folder.name))
  {
    // Create given folder in the local account
    await browser.fileIO.createArchiveLocalFolder(localAccountId, folder.name, parentPath);

    // Recursively create subfolders for this folder
    const subFolders = await browser.folders.getSubFolders(folder.id);
    parentPath = parentPath+folder.name+"|";
    for (const sub of subFolders) {
      await createLocalFolder(sub, localAccountId, parentPath, storedFolders);
    }
  }
}

// New code archiving by folder
async function localyArchiveMessagesBeforeDate(accountId, folder, cutoffDate) {
  archibaldLog("Archiving folder: " + folder.name + " before: " + cutoffDate);
  let archiveCount = 0;

  /*for (const msg of messagesToArchive) {
    await browser.messages.move([msg.id], currentFolderUri);
    archiveCount++;
  }

  archibaldLog(`${archiveCount} messages archived from ${folder.name}.`);*/
  return archiveCount;
}

async function createAccountLocalFolders(accountId)
{
  const accounts = await browser.accounts.list();
  const account = accounts.find(acc => acc.id === accountId);
  const storedData = await browser.storage.local.get(accountId);

  const localAccount = accounts.find(acct => acct.type === "local");
  if (!localAccount)
      throw new Error("Local account not found.");

  if (!account) {
      archibaldLog(`No account found for id ${accountId}`);
      return;
  }

  // Creating the account main folder under "Archives" (the default root)
  await browser.fileIO.createArchiveLocalFolder(localAccount.id, account.name, "");
  const parentPath = account.name+"|";

  //accountTitle.textContent = `Compte : ${account.name}`;
  // Start populating from root folders
  const folders = await browser.folders.getSubFolders(accountId);
  // Do not create some default folders
  const blacklist = ["Archives", "Indésirables"];
  for (const folder of folders) {
    if (!blacklist.includes(folder.name)) {
      // parentPath in the form of accountname/folder1/folder2
      await createLocalFolder(folder, localAccount.id, parentPath, storedData[accountId]);
    }
  }
}

// Old code archiving by year
// Archive messages as .eml files in year-based subfolders inside basePath
async function yearlyArchiveMessagesBeforeDate(folder, cutoffDate) {
  archibaldLog("Localy archiving folder: " + folder.name + " - before: " + cutoffDate);

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

    // Use fileIO experimental to create local folder
    const yearFolderUri = await browser.fileIO.createArchiveLocalFolder(localAccount.id, messageYear);

    // Move the message to the right local folder
    await browser.messages.move([msg.id], yearFolderUri);
    archiveCount++;
  }

  archibaldLog(`${archiveCount} messages archived from ${folder.name}.`);
  return archiveCount;
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

// Ok button
document.getElementById("ok").addEventListener("click", async () => {
  // Selected Account
  const mailboxDropdown = document.getElementById("mailboxDropdown");
  const selectedMailbox = mailboxDropdown.options[mailboxDropdown.selectedIndex];
  const accountId = JSON.parse(selectedMailbox.value).accountId;

  // Selected Folders and date
  const storedFolders = await browser.storage.local.get(accountId);
  const storedFoldersForSelectedAccount = storedFolders[accountId];
  const selectedDate = document.getElementById("until");

  // Prepare window style
  const progressBar = document.getElementById("progressBar");
  readyArchibaldWindow();

  try {
    storeFormValues();
    if(document.getElementById("local").checked)
    {
      // Simply download a zip folder
      //downloadAsZip(storedFoldersForSelectedAccount, new Date(selectedDate.value));

      let i = 0;
      for (const folder of storedFoldersForSelectedAccount) {
        // Create local folder hierarchy
        createAccountLocalFolders(accountId);
        archiveCount += await localyArchiveMessagesBeforeDate(accountId, folder, new Date(selectedDate.value));

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
  browser.storage.local.set({ ["local"]: document.getElementById("local").checked });
}

// Restore the Archibald form from local storage
async function restoreFormFromLocalStorage()
{
  // Local archiving checkbox (checked by default)
  const local = (await browser.storage.local.get("local")).local;
  document.getElementById("local").checked = (local === undefined || local === null) ? true : !!local;

  // Day count value (365 by default)
  const days = (await browser.storage.local.get("days")).days;
  document.getElementById("days").value = days ?? "365";
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
}

// Close the window on cancel
document.getElementById("cancel").addEventListener("click", async () => {
    storeFormValues();
    archibaldLog("Closing main window");
    window.close();
});

function archibaldLog(consoleString)
{
  console.log("[Archibald] - "+ consoleString);
}

async function setDefaultFoldersForAccount(accountId) {
  const account = await browser.accounts.get(accountId);
  archibaldLog("Setting default folders for account: "+accountId);
  const folders = await browser.folders.getSubFolders(accountId);

  // Start to collect folders from the selected account
  const selectedFolders = [];
  for (const folder of folders)
    await collect(folder);

  async function collect(folder) {
    const blacklist = ["Archives", "Indésirables"];
    const greylist = ["Corbeille", "Brouillons", "Modèles", "Éléments envoyés"];

    if (!blacklist.includes(folder.name) && !greylist.includes(folder.name)) {
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