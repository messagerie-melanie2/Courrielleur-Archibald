// content/archibaldLogic.js
// Core business logic for Archibald archiving (shared between background script and Archibald tab)

function archibaldLog(...args) {
  console.log("[Archibald]", ...args);
}

// Decodes RFC 3501 modified UTF-7 and percent-encoded folder names (used in IMAP URLs)
function decodeImapUtf7(str) {
  if (!str || typeof str !== "string") return "";
  try {
    str = decodeURIComponent(str);
  } catch (_) {
    str = str.replace(/%20/g, " ");
  }

  return str.replace(/&([^-]*)-/g, (match, b64) => {
    if (b64 === "") return "&";
    try {
      let base64 = b64.replace(/,/g, "/");
      while (base64.length % 4 !== 0) {
        base64 += "=";
      }
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder("utf-16be").decode(bytes);
    } catch (_) {
      return match;
    }
  });
}

// Folder names accents are encoded in modified IMAP UTF-7 or percent-encoding, decode them...
function decodeLegacyFolderName(str) {
  if (!str || typeof str !== "string") return "";
  str = decodeImapUtf7(str);

  const legacyMap = {
    '%20': ' ',
    '&AMk-': 'É',
    '&AOk-': 'é',
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
    '&AOl-': 'ù',
    '&AOm-': 'û',
    '&AOn-': 'ü',
    '&AOo-': 'ÿ',
    '&AOp-': 'œ',
    '&AOq-': 'æ',
    '&AOr-': 'ß',
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
    if (str.includes(key)) {
      str = str.split(key).join(val);
    }
  }

  return str;
}

function sanitizeFolderName(name) {
  if (!name || typeof name !== "string") return "";
  if (name.includes("/")) {
    name = name.split(" - ")[0].replaceAll("/", ".");
  }
  return name;
}

function parsePairs(str) {
  return (str || "").split("|").filter(Boolean).map(entry => {
    const [id, ...rest] = entry.split(",");
    return [id, rest.join(",")];
  });
}

function upsertPair(str, id, path) {
  const pairs = parsePairs(str);
  let found = false;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === id) {
      pairs[i][1] = path;
      found = true;
      break;
    }
  }
  if (!found) pairs.push([id, path]);
  return pairs.map(([i, p]) => `${i},${p}`).join("|");
}

function findPath(str, id) {
  for (const [i, p] of parsePairs(str)) {
    if (i === id) return p;
  }
  return "";
}

function toBool(str, fallback = false) {
  if (str === "" || str == null) return fallback;
  const s = String(str).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function boolToToken(b) {
  return b ? "1" : "0";
}

async function getLocalAccountByName(name) {
  const accounts = await browser.accounts.list();
  const localAccounts = accounts.filter(acct => acct.type === "local");
  for (const account of localAccounts) {
    if (account.name === name) {
      archibaldLog("Found matching local account: " + account.name);
      return account;
    }
  }
  return null;
}

async function getDefaultLocalAccount() {
  try {
    const accounts = await browser.accounts.list();
    const localAccounts = accounts.filter(acct => acct.type === "local");
    for (const account of localAccounts) {
      if (account.name === "Dossiers locaux") {
        archibaldLog("Returning default localAccount: " + account.name);
        return account;
      }
    }
    archibaldLog("No default local account found.");
    return null;
  } catch (ex) {
    archibaldLog("Error in getDefaultLocalAccount: " + ex.message);
    return null;
  }
}

async function getAccountCustomLocalFolderConfig(accountId) {
  const { useCustomLocalFolderByAccount, useCustomLocalFolder, localFolderPaths } = await browser.storage.local.get([
    "useCustomLocalFolderByAccount",
    "useCustomLocalFolder",
    "localFolderPaths"
  ]);

  const perAccountFlagToken = findPath(useCustomLocalFolderByAccount || "", accountId);
  let useCustom = toBool(perAccountFlagToken, null);
  if (useCustom === null) {
    useCustom = toBool(useCustomLocalFolder, false);
  }

  const customPath = findPath(localFolderPaths || "", accountId) || "";

  return { useCustom, customPath };
}

async function getAccountLocalAccount(originalAccount, forceCreation) {
  try {
    const localAccountName = "Local - " + originalAccount.name;

    let useCustomLocalFolder = null;
    let customPath = null;

    if (typeof document !== "undefined") {
      const dropdown = document.getElementById("mailboxDropdown");
      if (dropdown && dropdown.selectedIndex >= 0) {
        try {
          const selectedOption = dropdown.options[dropdown.selectedIndex];
          const selectedAccountId = JSON.parse(selectedOption.value).accountId;
          if (selectedAccountId === originalAccount.id) {
            const cb = document.getElementById("useCustomLocalFolder");
            if (cb) useCustomLocalFolder = cb.checked;
            const pathInput = document.getElementById("localFolderPath");
            if (pathInput) customPath = pathInput.value;
          }
        } catch (_) {}
      }
    }

    if (useCustomLocalFolder === null) {
      const config = await getAccountCustomLocalFolderConfig(originalAccount.id);
      useCustomLocalFolder = config.useCustom;
      customPath = config.customPath;
    }

    if (!useCustomLocalFolder) {
      archibaldLog("Getting default local account for " + originalAccount.name);
      return await getDefaultLocalAccount();
    } else {
      archibaldLog("Searching local account for: " + originalAccount.name);
      let localAccount = await getLocalAccountByName(localAccountName);
      if (localAccount) return localAccount;

      archibaldLog("No local account found for: " + originalAccount.name);
      if (forceCreation) {
        archibaldLog("Creating custom local account for: " + originalAccount.name);
        const path = customPath;
        if (!path) {
          archibaldLog("User needs to choose a target folder for " + originalAccount.name);
          if (typeof alert === "function" && typeof document !== "undefined") {
            alert("Choisissez un dossier local");
          }
          throw new Error("Dossier local personnalisé non configuré pour le compte « " + originalAccount.name + " ».");
        }
        const newLocalAccountName = await browser.archibaldApi.createCustomLocalFolder(originalAccount.id, path);
        archibaldLog("Created local account: " + newLocalAccountName);

        localAccount = await getLocalAccountByName(localAccountName);
        if (localAccount) return localAccount;
      }
      return null;
    }
  } catch (ex) {
    archibaldLog("Error in getAccountLocalAccount: " + (ex?.message || ex));
    if (typeof alert === "function" && typeof document !== "undefined") {
      alert(ex.message || ex);
    }
    throw ex;
  }
}

async function createLocalFolder(folder, localAccountId, parentPath, storedFolders) {
  const storedList = storedFolders || [];
  const decodedFolderPath = decodeLegacyFolderName(folder.path);
  const decodedFolderName = decodeLegacyFolderName(folder.name);

  const isFolderChecked = storedList.some(f =>
    f.name === folder.name ||
    decodeLegacyFolderName(f.name) === decodedFolderName ||
    sanitizeFolderName(f.name) === sanitizeFolderName(folder.name) ||
    f.path === folder.path ||
    decodeLegacyFolderName(f.path) === decodedFolderPath
  );

  async function hasCheckedDescendants(currentFolder) {
    const subFolders = await browser.folders.getSubFolders(currentFolder.id);
    for (const sub of subFolders) {
      const decodedSubPath = decodeLegacyFolderName(sub.path);
      const decodedSubName = decodeLegacyFolderName(sub.name);
      if (storedList.some(f =>
        f.name === sub.name ||
        decodeLegacyFolderName(f.name) === decodedSubName ||
        sanitizeFolderName(f.name) === sanitizeFolderName(sub.name) ||
        f.path === sub.path ||
        decodeLegacyFolderName(f.path) === decodedSubPath
      )) {
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
    const sanitizedFolderName = sanitizeFolderName(decodedFolderName || folder.name);
    await browser.archibaldApi.createArchiveLocalFolder(localAccountId, sanitizedFolderName, parentPath);
    const newParentPath = parentPath + sanitizedFolderName + "/";
    const subFolders = await browser.folders.getSubFolders(folder.id);
    for (const sub of subFolders) {
      await createLocalFolder(sub, localAccountId, newParentPath, storedFolders);
    }
  }
}

async function createAccountLocalFolders(account, localAccount, pendingFolders) {
  let storedData = null;
  if (!pendingFolders) {
    storedData = await browser.storage.local.get(account.id);
  }

  if (!account) {
    archibaldLog(`No account found for id ${account.id}`);
    return;
  }

  await browser.archibaldApi.createArchiveLocalFolder(localAccount.id, sanitizeFolderName(account.name), "");
  const parentPath = sanitizeFolderName(account.name) + "/";

  const folders = await browser.folders.getSubFolders(account.id);
  const hasExactBoitePartagee = folders.some(f => f.name === "Boite partagée");
  const blacklist = ["Archives", "Indésirables"];
  for (const folder of folders) {
    const decodedName = decodeLegacyFolderName(folder.name);
    if (!blacklist.includes(folder.name) && !blacklist.includes(decodedName)) {
      if (hasExactBoitePartagee && decodedName === "Boite partagée" && folder.name !== "Boite partagée") {
        continue;
      }
      await createLocalFolder(folder, localAccount.id, parentPath, pendingFolders ? pendingFolders : storedData[account.id]);
    }
  }
}

async function getLocalFolder(originalAccount, targetPath) {
  let localAccount = await getAccountLocalAccount(originalAccount, true);

  if (!localAccount) {
    archibaldLog("Local account not found.");
    return null;
  }
  const localAccountRootFolders = await browser.folders.getSubFolders(localAccount.id);

  const nameParts = targetPath.split("/").filter(Boolean);
  for (const rootFolder of localAccountRootFolders) {
    if (rootFolder.name === "Archives") {
      archibaldLog("Starting folder search recurrence inside Archives local folder for " + decodeLegacyFolderName(targetPath));
      const result = await findFolderByParts(rootFolder, nameParts.slice(1));
      if (result) return result;
    }
  }

  return null;

  async function findFolderByParts(currentFolder, remainingParts) {
    if (remainingParts.length === 0) {
      archibaldLog("Search finished, returning folder " + currentFolder.name);
      return currentFolder;
    }
    const subFolders = await browser.folders.getSubFolders(currentFolder.id);
    const nextPart = remainingParts[0];

    const decodedNextPart = decodeLegacyFolderName(nextPart);
    const sanitizedNextPart = sanitizeFolderName(nextPart);

    const nextFolder = subFolders.find(f =>
      f.name === nextPart ||
      f.name === decodedNextPart ||
      f.name === sanitizedNextPart ||
      f.name === decodeLegacyFolderName(sanitizedNextPart) ||
      decodeLegacyFolderName(f.name) === decodedNextPart ||
      decodeLegacyFolderName(f.name) === nextPart
    );
    if (!nextFolder) return null;

    return await findFolderByParts(nextFolder, remainingParts.slice(1));
  }
}

async function setDefaultFoldersForAccount(accountId) {
  const account = await browser.accounts.get(accountId);
  archibaldLog("Setting default folders for account: " + accountId);
  const folders = await browser.folders.getSubFolders(accountId);
  const isBalp =
    account?.identities?.some(id => id?.email?.includes(".-.")) ||
    folders.some(f => decodeLegacyFolderName(f.name) === "Boite partagée");
  const hasExactBoitePartagee = folders.some(f => f.name === "Boite partagée");

  const selectedFolders = [];
  for (const folder of folders) {
    const decodedRootName = decodeLegacyFolderName(folder.name);
    if (hasExactBoitePartagee && decodedRootName === "Boite partagée" && folder.name !== "Boite partagée") {
      continue;
    }
    if (isBalp && (folder.path === "/INBOX" || folder.name === "Courrier entrant")) {
      const subs = await browser.folders.getSubFolders(folder.id);
      for (const sub of subs) {
        await collect(sub);
      }
      continue;
    }
    await collect(folder);
  }

  async function collect(folder) {
    const blacklist = ["Archives", "Indésirables"];
    const greylist = ["Corbeille", "Brouillons", "Modèles", "Éléments envoyés"];
    const decodedName = decodeLegacyFolderName(folder.name);

    if (
      !blacklist.includes(folder.name) &&
      !blacklist.includes(decodedName) &&
      !greylist.includes(folder.name) &&
      !greylist.includes(decodedName)
    ) {
      if (decodedName !== "Boite partagée") {
        archibaldLog("Collecting default folder:", folder.name);

        selectedFolders.push({
          name: folder.name,
          path: folder.path,
          id: folder.id,
          accountId: folder.accountId,
        });
      }

      const subFolders = await browser.folders.getSubFolders(folder.id);
      for (const sub of subFolders) {
        await collect(sub);
      }
    }
  }

  await browser.storage.local.set({ [accountId]: selectedFolders });
  archibaldLog("Saved default folders for account: " + accountId);
}

async function localyArchivePendingMessages(messages, account, currentPath) {
  if (!messages || messages.length === 0) return 0;

  archibaldLog("Archiving pending messages");
  const fallbackFolderName = currentPath ? currentPath.split("/").filter(Boolean).pop() : "Dossier";
  const sourceFolderName = decodeLegacyFolderName(messages[0]?.folderName) || fallbackFolderName;
  let archiveCount = 0;

  const localFolderPath = `Archives/${sanitizeFolderName(account.name)}${currentPath.replace("INBOX", "Courrier entrant")}`;

  let targetFolder = await getLocalFolder(account, localFolderPath);
  if (!targetFolder) {
    archibaldLog(`Target local folder not found: ${localFolderPath}, creating it now...`);
    const localAccount = await getAccountLocalAccount(account, true);
    if (localAccount) {
      const parts = localFolderPath.split("/").filter(Boolean);
      let parentPath = "";
      for (let i = 1; i < parts.length; i++) {
        const partName = sanitizeFolderName(parts[i]);
        await browser.archibaldApi.createArchiveLocalFolder(localAccount.id, partName, parentPath);
        parentPath += partName + "/";
      }
      targetFolder = await getLocalFolder(account, localFolderPath);
    }
  }

  if (!targetFolder) {
    archibaldLog(`Target local folder not found: ${localFolderPath}`);
    return 0;
  }

  for (const msg of messages) {
    let queryResult = await browser.messages.query({ headerMessageId: msg.messageId });
    if ((!queryResult.messages || queryResult.messages.length === 0) && msg.messageId) {
      const altId = msg.messageId.startsWith("<") && msg.messageId.endsWith(">")
        ? msg.messageId.slice(1, -1)
        : `<${msg.messageId}>`;
      queryResult = await browser.messages.query({ headerMessageId: altId });
    }

    if (queryResult.messages && queryResult.messages.length > 0) {
      let webExtMessageId = queryResult.messages[0].id;
      try {
        await browser.messages.move([webExtMessageId], targetFolder.id);
        archiveCount++;
      } catch (e) {
        console.error("Failed to list/move message:", e, "message:", e?.message, "stack:", e?.stack);
        archibaldLog("Failed to move message:", e?.message || String(e));
      }
    } else {
      console.warn("Could not find message for messageId", msg.messageId);
      archibaldLog(`Could not find message for messageId: ${msg.messageId}`);
    }
  }

  archibaldLog(`${archiveCount} pending messages archived from ${sourceFolderName}.`);
  return archiveCount;
}

// Main entry point for manual/pending archive requests
async function processArchiveMessages(messages) {
  if (!messages || messages.length === 0) return 0;

  const accounts = await browser.accounts.list();

  const messagesByAccount = new Map();
  for (const msg of messages) {
    const accId = msg.accountId || (accounts[0] ? accounts[0].id : null);
    if (!messagesByAccount.has(accId)) {
      messagesByAccount.set(accId, []);
    }
    messagesByAccount.get(accId).push(msg);
  }

  let totalArchived = 0;

  for (const [accountId, accMessages] of messagesByAccount.entries()) {
    const account = accounts.find(acc => acc.id === accountId);
    if (!account) {
      archibaldLog("Account not found: " + accountId);
      continue;
    }

    const messagesByFolder = new Map();
    for (const msg of accMessages) {
      const fUri = msg.folderURI || "";
      if (!messagesByFolder.has(fUri)) {
        messagesByFolder.set(fUri, []);
      }
      messagesByFolder.get(fUri).push(msg);
    }

    let storedFolders = await browser.storage.local.get(accountId);
    if (storedFolders[accountId] == undefined) {
      await setDefaultFoldersForAccount(accountId);
      storedFolders = await browser.storage.local.get(accountId);
    }
    const pendingFolders = storedFolders[accountId] || [];

    for (const [folderURI, folderMessages] of messagesByFolder.entries()) {
      let pendingMessageFolders = (folderURI && typeof folderURI === "string") ? folderURI.split("/").slice(3) : [];
      let currentPath = "";

      pendingMessageFolders.forEach((folderName, index) => {
        let decodedName = decodeLegacyFolderName(folderName);
        if (index === pendingMessageFolders.length - 1 && folderMessages[0]?.folderName) {
          decodedName = decodeLegacyFolderName(folderMessages[0].folderName);
        }
        currentPath += "/" + decodedName;
        let folder = {
          name: decodedName,
          path: currentPath,
          id: accountId + "://" + currentPath.slice(1),
          accountId: accountId
        };

        if (!pendingFolders.some(f => f.name === folder.name || f.path === folder.path)) {
          pendingFolders.push(folder);
        }
      });

      const localAccount = await getAccountLocalAccount(account, true);
      if (!localAccount) {
        throw new Error("Compte local introuvable pour : " + account.name);
      }

      await createAccountLocalFolders(account, localAccount, pendingFolders);

      const count = await localyArchivePendingMessages(folderMessages, account, currentPath);
      totalArchived += count;
    }
  }

  return totalArchived;
}
