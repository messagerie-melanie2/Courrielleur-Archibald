let WIDTH = 500;
let HEIGHT = 500;

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

function getAccountIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("accountId");
}

document.addEventListener("DOMContentLoaded", async () => {
  const folderListContainer = document.getElementById("folderList");
  const accountTitle = document.getElementById("accountName");
  const accountId = getAccountIdFromUrl();
  const storedData = await browser.storage.local.get(accountId);

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
      const blacklist = ["Archives", "Corbeille", "Indésirables", "Brouillons", "Modèles", "Éléments envoyés"];
      if (!blacklist.includes(folder.name))
        renderFolder(folder, folderListContainer, 0, storedData[accountId]);
  });
});

function renderFolder(folder, container, level, storedFolders) {
    const item = document.createElement("div");
    item.className = "folder-item";

    // Check folder by default
    let checked = true;
    // Check folders or not depending on the storedFolders if we have some
    if (storedFolders)
      checked = storedFolders.some(f => f.name === folder.name);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.dataset.folder = JSON.stringify({
        name: folder.name,
        path: folder.path,
        id: folder.id,
        accountId: folder.accountId
    });

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
            renderFolder(subFolder, container, level + 1, storedFolders);
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
          id: folderData.id,
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

    console.log("Storing folders: "+selectedFolders.map( function( folder ){ return folder.name; }));
    await browser.storage.local.set({
      [accountId]: selectedFolders
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