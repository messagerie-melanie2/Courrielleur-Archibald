document.addEventListener("DOMContentLoaded", async () => {
    const folderListContainer = document.getElementById("folderList");
    const accountTitle = document.getElementById("accountName");

    const accounts = await browser.accounts.list();

    const account = accounts[0];
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
document.getElementById("ok").addEventListener("click", () => {
    const checkboxes = document.querySelectorAll(".folder-item input[type='checkbox']");
    const selectedFolders = [];

    checkboxes.forEach(checkbox => {
      if (checkbox.checked) {
        const folderData = JSON.parse(checkbox.dataset.folder);
        selectedFolders.push(folderData);
      }
    });

    if (window.opener) {
      window.opener.postMessage({ type: "selectedFolders", folders: selectedFolders }, "*");
      window.close();
    } else {
      console.error("No opener window found.");
    }
  });

// Cancel button
document.getElementById("cancel").addEventListener("click", async () => {
    const win = await browser.windows.getCurrent();
    await browser.windows.remove(win.id);
});