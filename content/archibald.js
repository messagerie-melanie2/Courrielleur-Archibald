const WIDTH = 500;
const HEIGHT = 280;

// Prevent user from resizing the window
function enforceFixedSizeOnResize()
{
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
              option.value = JSON.stringify(folder);
              option.textContent = `${account.name} – ${folder.name}`;
              dropdown.appendChild(option);
          }
        }
    }
}
document.addEventListener("DOMContentLoaded", populateInboxDropdown);

// Dynamicly adjust date and day counts
document.addEventListener("DOMContentLoaded", () => {
  const daysInput = document.getElementById("days");
  const dateInput = document.getElementById("until");
  const mailbox = document.getElementById("mailboxDropdown");

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

  // Load folder list for the selected account (create it if necessary)
  mailbox.addEventListener("change", async (event) => {
    const selectedOption = event.target.selectedOptions[0];
    const accountData = JSON.parse(selectedOption.value);
    const accountId = accountData.id;

    const filePath = "defaults/"+accountId+".json";

    try {
      // Try to read the stored folder list
      let storedData = {};
      try {
        const fileContent = await browser.runtime.sendMessage({
          type: "readFile",
          path: filePath
        });
        storedData = JSON.parse(fileContent);
      } catch (err) {
        console.log("No existing "+accountId+".json found, will create new.");
      }

      if (storedData[accountId]) {
        console.log(`Using stored folder list for account ${accountId}.`);
      } else {
        console.log(`No folder list found for ${accountId}, generating default list.`);
        await saveDefaultFoldersForAccount(accountId);
      }
    } catch (err) {
      console.error("Error handling account selection:", err);
    }
  });
});

// TODO Finish and test archive process
async function archiveMessagesBeforeDate(folder, cutoffDate) {
    // Convert Date object to ISO string (UTC midnight)
    const cutoffTimestamp = cutoffDate.getTime();

    // Get all messages in the folder
    const messages = await browser.messages.list(folder);

    // Filter messages older than the given date
    const messagesToArchive = messages.messages.filter(msg => {
      const msgDate = new Date(msg.date).getTime();
      return msgDate < cutoffTimestamp;
    });

    // Archive the filtered messages
    for (const msg of messagesToArchive) {
      await browser.messages.archive([msg.id]);
    }

    console.log(`${messagesToArchive.length} messages archived.`);
}

// Ok button
document.getElementById("ok").addEventListener("click", async () => {
  console.log("Starting Archiving");

  const selectedOption = dropdown.selectedOptions[0];
  const accountId = selectedOption.dataset.accountId;
  const path = selectedOption.dataset.path;

  // Find the folder again
  const account = (await browser.accounts.list()).find(acc => acc.id === accountId);
  const folder = findFolderByPath(account.folders, path);

  await archiveMessagesBeforeDate(document.getElementById("mailboxDropdown").value, new Date((document.getElementById("until").value)));
});

// Cancel button - simply closes the window, TODO: cancel archiving ?
document.getElementById("cancel").addEventListener("click", async () => {
    console.log("Closing Archibald");
    const win = await browser.windows.getCurrent();
    await browser.windows.remove(win.id);
});

async function saveDefaultFoldersForAccount(accountId) {
  const account = await browser.accounts.get(accountId);
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

  await browser.runtime.sendMessage({
    type: "writeFile",
    path: filePath,
    content: JSON.stringify(allFolders, null, 2)
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