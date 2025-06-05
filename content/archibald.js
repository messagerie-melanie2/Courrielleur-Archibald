let WIDTH = 500;
let HEIGHT = 280;
let archiveCount = 0;

// Prevent user from resizing the window
function enforceFixedSizeOnResize() {
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
document.addEventListener("DOMContentLoaded", enforceFixedSizeOnResize);

// List all available accounts
async function populateInboxDropdown() {
  const dropdown = document.getElementById("mailboxDropdown");
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
  loadFolderListForSelectedAccount();
}
document.addEventListener("DOMContentLoaded", populateInboxDropdown);

// Dynamicly adjust date and day counts
document.addEventListener("DOMContentLoaded", () => {
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
});

// Load folder list for the selected account (create it if necessary)
async function loadFolderListForSelectedAccount() {
  console.log("Loading folder list for selected account.");
  const selectedMailbox = document.getElementById("mailboxDropdown").selectedOptions[0];
  const { accountId, folderPath } = JSON.parse(selectedMailbox.value);

  try {
    const storedData = await browser.storage.local.get(accountId);

    if (storedData[accountId]) {
      const folderNames = storedData[accountId].map(f => f.name).join(", ");
      console.log(`Using stored folder list for account ${accountId}: ${folderNames}`);
    } else {
      console.log(`No folder list found for ${accountId}, generating default list.`);
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

// Archive folder messages before cutoffDate
async function archiveMessagesBeforeDate(folder, cutoffDate) {
  console.log("Archiving folder: " + folder.name + " - before: " + cutoffDate);

  const cutoffTimestamp = cutoffDate.getTime();

  console.log("Calling messages.list with folderId: " + folder.id);
  const messages = await browser.messages.list(folder.id);
  const messagesToArchive = messages.messages.filter(msg => {
    const msgDate = new Date(msg.date).getTime();
    return msgDate < cutoffTimestamp;
  });

  for (const msg of messagesToArchive) {
    await browser.messages.archive([msg.id]);
    archiveCount++;
  }

  console.log(`${messagesToArchive.length} messages archived from ${folder.name}.`);
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
    let i = 0;
    for (const folder of storedFoldersForSelectedAccount) {
      await archiveMessagesBeforeDate(folder, new Date(selectedDate.value));

      // Update progress bar
      const progress = Math.round(((i + 1) / storedFoldersForSelectedAccount.length) * 100);
      progressBar.value = progress;
      i++;
    }
  }
  catch (error) {
    console.error("An error occurred: "+error.message);
  }

  // Reset window style
  resetArchibaldWindow();
  setTimeout(() => {
    if(archiveCount > 0)
      alert("Archivage terminé ! " + archiveCount + " messages déplacés.");
    else
      alert("Aucun message à archiver.");
    archiveCount = 0;
  }, 200);
});

// Prepare window for archiving
function readyArchibaldWindow()
{
  // Resize to accomodate progress bar
  HEIGHT = HEIGHT+60;
  browser.windows.getCurrent().then(win => {
    browser.windows.update(win.id, {
      width: WIDTH,
      height: HEIGHT
    });
  });

  // Show Progress Bar & Disable buttons
  const progressContainer = document.getElementById("progressContainer");
  const progressBar = document.getElementById("progressBar");
  progressContainer.style.display = "block";
  document.getElementById("ok").disabled = true;
  document.getElementById("cancel").disabled = true;
}

// Reset window state
function resetArchibaldWindow()
{
  // Hide Progress Bar and enable buttons
  document.getElementById("progressContainer").style.display = "none";
  document.getElementById("progressBar").value = 0;
  document.getElementById("ok").disabled = false;
  document.getElementById("cancel").disabled = false;

  // Resize to hide progressbar
  HEIGHT = HEIGHT-60;
  browser.windows.getCurrent().then(win => {
    browser.windows.update(win.id, {
      width: WIDTH,
      height: HEIGHT
    });
  });
}

// Cancel button - simply closes the window, TODO: cancel archiving ?
document.getElementById("cancel").addEventListener("click", async () => {
    console.log("Closing Archibald");
    const win = await browser.windows.getCurrent();
    await browser.windows.remove(win.id);
});

async function setDefaultFoldersForAccount(accountId) {
  const account = await browser.accounts.get(accountId);
  console.log("Setting default folders for account: "+account);
  const folders = await browser.folders.getSubFolders(account);

  // Flatten folders recursively
  const allFolders = [];
  function collect(folderArray) {
    for (const folder of folderArray) {
      const blacklist = ["Archives", "Corbeille", "Indésirables", "Brouillons", "Modèles", "Éléments envoyés"];
      if (!blacklist.includes(folder.name))
      {
        allFolders.push({
          name: folder.name,
          path: folder.path,
          id: folder.id,
          accountId: folder.accountId
        });
        if (folder.subFolders?.length)
          collect(folder.subFolders);
        console.log(folder.id);
      }

    }
  }
  collect(folders);

  const filePath = "defaults/"+ accountId +".json";

  await browser.storage.local.set({
    [accountId]: selectedFolders
  });

  console.log("Saved default folders for account: "+accountId);
}

// Open folder list popup
document.getElementById("folders").addEventListener("click", async () => {
  const dropdown = document.getElementById("mailboxDropdown");
  const selectedOption = dropdown.options[dropdown.selectedIndex];
  const accountId = JSON.parse(selectedOption.value).accountId;
  const width = 500;
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
  });
});

window.addEventListener("message", (event) => {
  if (event.data?.type === "selectedFolders") {
    const selectedFolders = event.data.folders;
    console.log("Received folders:", selectedFolders);
  }
});