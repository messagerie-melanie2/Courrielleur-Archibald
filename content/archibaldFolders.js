// Not usefull in an Iframe
/*let WIDTH = 500;
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
document.addEventListener("DOMContentLoaded", enforceFixedSizeOnResize);*/
const BALP_ID = ".-.";
function getAccountIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("accountId");
}

document.addEventListener("DOMContentLoaded", async () => {
  const folderListContainer = document.getElementById("folderList");
  //const accountTitle = document.getElementById("accountName");
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

  //accountTitle.textContent = `Compte : ${account.name}`;

  //console.log(account);
  //console.log(account.identities[0].email);
  // Start populating from root folders
  const folders = await browser.folders.getSubFolders(accountId);
  // Do not render some default folders
  const blacklist = ["Archives", "Indésirables"];
  for (const folder of folders) {
    if (!blacklist.includes(folder.name)) {
      // Affichage modifié pour les BALP
      if(account.identities[0].email.includes(BALP_ID))
        await renderSharedFolder(folder, folderListContainer, 0, storedData[accountId], false);
      else
        await renderFolder(folder, folderListContainer, 0, storedData[accountId]);
    }
  }
  // Send height to main popup
  adjustFormHeight();
});

async function renderFolder(folder, container, level, storedFolders) {
  const item = document.createElement("div");
  item.className = "folder-item";

  let checked = true;
  // Default greylist folders to unchecked
  const greylist = ["Corbeille", "Brouillons", "Modèles", "Éléments envoyés"];
  const isGreylisted = greylist.some(item => folder.path.includes(`/${item}/`) || folder.path.endsWith(`/${item}`));
  if (isGreylisted)
    checked = false;

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
  labelContainer.style.paddingLeft = `${level * 20}px`;
  labelContainer.style.flex = "1";

  item.appendChild(checkbox);
  item.appendChild(labelContainer);
  container.appendChild(item);

  // Dynamically fetch and render subfolders
  const subFolders = await browser.folders.getSubFolders(folder.id);
  for (const sub of subFolders) {
    await renderFolder(sub, container, level + 1, storedFolders);
  }
}

async function renderSharedFolder(folder, container, level = 0, storedFolders, flattenOneLevel) {
  // --- Skip technical "Boite partagée" placeholder ---
  if (folder.name === "Boite partagée") {
    const subs = await browser.folders.getSubFolders(folder.id);
    for (const sub of subs) {
      // when diving into children, enable one-level flattening
      await renderSharedFolder(sub, container, level, storedFolders, true);
    }
    return;
  }

  // --- Skip "Courrier entrant" itself but flatten its children ---
  if (folder.name === "Courrier entrant") {
    const subs = await browser.folders.getSubFolders(folder.id);
    for (const sub of subs) {
      // flatten only one level here
      await renderSharedFolder(sub, container, level, storedFolders, true);
    }
    return;
  }

  // --- Adjust indentation only for the *first* flattened level ---
  let renderLevel = flattenOneLevel ? 0 : level;

  // --- Render the folder row ---
  const item = document.createElement("div");
  item.className = "folder-item";

  let checked = true;
  const greylist = ["Corbeille", "Brouillons", "Modèles", "Éléments envoyés"];
  const isGreylisted = greylist.some(item => folder.path.includes(`/${item}/`) || folder.path.endsWith(`/${item}`));
  if (isGreylisted)
    checked = false;

  if (storedFolders) {
    checked = storedFolders.some(f => f.name === folder.name);
  }

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
  labelContainer.textContent = isEntrantBalp(folder) ? "Courrier entrant" : folder.name;
  labelContainer.style.paddingLeft = `${renderLevel * 20}px`;
  labelContainer.style.flex = "1";

  item.appendChild(checkbox);
  item.appendChild(labelContainer);
  container.appendChild(item);

  // --- Render children ---
  const subFolders = await browser.folders.getSubFolders(folder.id);
  for (const sub of subFolders) {
    // Once we pass the first flattened level, go back to normal indentation
    if(isEntrantBalp(folder))
      await renderSharedFolder(sub, container, renderLevel, storedFolders, false);
    else
      await renderSharedFolder(sub, container, renderLevel + 1, storedFolders, false);
  }
}

function isEntrantBalp(folder)
{
  // length == 3 because we are looking for this folder "/Boite partagée/sg.snum...""
  if(folder.path.split("/").length == 3 && folder.path.includes("Boite partag"))
    return true;
  return false;
}


document.getElementById("masterCheckbox").addEventListener("change", function() {
  const allFolderCheckboxes = document.querySelectorAll('#folderList input[type="checkbox"]');
  allFolderCheckboxes.forEach(checkbox => {
    checkbox.checked = this.checked;
  });
});

function adjustFormHeight() {
  // Send the height of the form to archibald.js
  const height = document.documentElement.scrollHeight;
  window.parent.postMessage({ action: "setArchibaldFoldersHeight", height }, "*");
}

// Ok button
document.getElementById("ok").addEventListener("click", async () => {
  try {
    const checkboxes = document.querySelectorAll(".folder-item input[type='checkbox']");
    const selectedFolders = [];

    for (const checkbox of checkboxes) {
      if (checkbox.checked) {
        if (checkbox.id === "masterCheckbox")
          continue;
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

    // Useless with iFrame, we need to hide the parent div instead
    /*const win = await browser.windows.getCurrent();
    await browser.windows.remove(win.id);*/
    closeArchibaldFolders();
  } catch (error) {
    console.error("Error while saving folders :", error);
  }
});

// Cancel button
document.getElementById("cancel").addEventListener("click", async () => {
    // Useless with iFrame, we need to hide the parent div instead
    /*const win = await browser.windows.getCurrent();
    await browser.windows.remove(win.id);*/
    closeArchibaldFolders();
});

function closeArchibaldFolders()
{
  // Send the request to close to archibald.js in order to hide the iframe div
  window.parent.postMessage({ action: "closeArchibaldFolders" }, "*");
}