const WIDTH = 500;
const HEIGHT = 280;

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
});

// Load folder list for the selected account (create it if necessary)
async function loadFolderListForSelectedAccount() {
  console.log("Loading folder list for selected account.");
  const selectedMailbox = document.getElementById("mailboxDropdown").selectedOptions[0];
  const { accountId, folderPath } = JSON.parse(selectedMailbox.value);

  try {
    const storedData = await browser.storage.local.get(accountId);

    if (storedData[accountId]) {
      console.log(`Using stored folder list for account ${accountId}.`);
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
// On change
document.getElementById("mailboxDropdown").addEventListener("change", loadFolderListForSelectedAccount);

// Archive folder messages before cutoffDate
async function archiveMessagesBeforeDate(folder, cutoffDate) {
  const cutoffTimestamp = cutoffDate.getTime();
  const folderId = { accountId: folder.accountId, path: folder.path };

  const messages = await browser.messages.list(folderId);

  const messagesToArchive = messages.messages.filter(msg => {
    const msgDate = new Date(msg.date).getTime();
    return msgDate < cutoffTimestamp;
  });

  console.log("Archiving folder: " + folder.name + " - before: " + cutoffDate);
  for (const msg of messagesToArchive) {
    await browser.messages.archive([msg.id]);
  }

  console.log(`${messagesToArchive.length} messages archived from ${folder.name}.`);
}

// Ok button
document.getElementById("ok").addEventListener("click", async () => {
  const mailboxDropdown = document.getElementById("mailboxDropdown");
  const selectedMailbox = mailboxDropdown.options[mailboxDropdown.selectedIndex];
  const accountId = JSON.parse(selectedMailbox.value).accountId;
  const storedFolders = await browser.storage.local.get(accountId);
  const storedFoldersForSelectedAccount = storedFolders[accountId];
  const selectedDate = document.getElementById("until");

  for (const folder of storedFoldersForSelectedAccount) {
    await archiveMessagesBeforeDate(folder, new Date(selectedDate.value));
  }
});

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
      allFolders.push({
        name: folder.name,
        path: folder.path,
        accountId: folder.accountId
      });
      if (folder.subFolders?.length) collect(folder.subFolders);
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

  await browser.windows.create({
    url: `./archibaldFolders.html?accountId=${encodeURIComponent(accountId)}`,
    type: "popup",
    width: 400,
    height: 300
  });
});

window.addEventListener("message", (event) => {
  if (event.data?.type === "selectedFolders") {
    const selectedFolders = event.data.folders;
    console.log("Received folders:", selectedFolders);

    // Do something with the selected folders
  }
});