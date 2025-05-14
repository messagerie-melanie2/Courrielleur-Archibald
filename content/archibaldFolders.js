function getAccountIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("accountId");
}

document.addEventListener("DOMContentLoaded", async () => {
  const folderListContainer = document.getElementById("folderList");
  const accountTitle = document.getElementById("accountName");
  const accountId = getAccountIdFromUrl();

  if (!accountId) {
      console.error("Missing accountId in URL");
      return;
  }

  const accounts = await browser.accounts.list();
  const account = accounts.find(acc => acc.id === accountId);

  if (!account) {
      console.error(`No account found for id ${accountId}`);
      return;
  }

  accountTitle.textContent = `Compte : ${account.name}`;

  // Start populating from root folders
  account.folders.forEach(folder => {
      renderFolder(folder, folderListContainer, 0);
  });
});

function renderFolder(folder, container, level) {
    const item = document.createElement("div");
    item.className = "folder-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.accountId = folder.accountId;
    checkbox.dataset.folderPath = folder.path;

    const labelContainer = document.createElement("div");
    labelContainer.textContent = folder.name;
    labelContainer.style.paddingLeft = `${level * 20}px`; // Indent based on level
    labelContainer.style.flex = "1";

    item.appendChild(checkbox);
    item.appendChild(labelContainer);
    container.appendChild(item);

    // Recursively render subfolders
    if (folder.subFolders && folder.subFolders.length > 0) {
        folder.subFolders.forEach(subFolder => {
        renderFolder(subFolder, container, level + 1);
        });
    }
}

// Ok button
document.getElementById("ok").addEventListener("click", async () => {
  try {
    const checkboxes = document.querySelectorAll(".folder-item input[type='checkbox']");
    const selectedFolders = [];

    for (const checkbox of checkboxes) {
      if (checkbox.checked) {
        const folderData = JSON.parse(checkbox.dataset.folder);
        selectedFolders.push({
          name: folderData.name,
          path: folderData.path,
          accountId: folderData.accountId
        });
      }
    }

    if (selectedFolders.length === 0) {
      alert("Veuillez sélectionner au moins un dossier.");
      return;
    }

    // Get accountId from dataset or stored value
    const accountId = getAccountIdFromUrl();
    if (!accountId) {
      console.error("Account ID not found in params.");
      return;
    }

    const filePath = `defaults/folderSelections-${accountId}.json`;

    await browser.runtime.sendMessage({
      type: "writeFile",
      path: filePath,
      content: JSON.stringify(selectedFolders, null, 2)
    });

    const win = await browser.windows.getCurrent();
    await browser.windows.remove(win.id);

  } catch (error) {
    console.error("Error while saving folders :", error);
  }
});

// Cancel button
document.getElementById("cancel").addEventListener("click", async () => {
    const win = await browser.windows.getCurrent();
    await browser.windows.remove(win.id);
});