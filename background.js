// Helper pour créer un espace ou mettre à jour ses propriétés s'il existe déjà
async function registerOrUpdateSpace(name, url, buttonProperties) {
  try {
    const existingSpaces = await browser.spaces.query({ isSelfOwned: true });
    const existing = existingSpaces?.find(s => s.name === name);
    if (existing) {
      const spaceId = existing.id ?? existing.spaceId;
      console.log(`[Archibald] - Space ${name} déjà existant (id: ${spaceId}), mise à jour des propriétés...`);
      await browser.spaces.update(spaceId, { url }, buttonProperties);
      console.log(`[Archibald] - Space ${name} mis à jour avec succès`);
      return existing;
    }
    const created = await browser.spaces.create(name, url, buttonProperties);
    console.log(`[Archibald] - Space ${name} créé avec succès, id:`, created?.id);
    return created;
  } catch (e) {
    if (e.message?.includes("already exists")) {
      console.log(`[Archibald] - Space ${name} déjà existant lors du create, tentative de mise à jour...`);
      try {
        const existingSpaces = await browser.spaces.query({ isSelfOwned: true });
        const existing = existingSpaces?.find(s => s.name === name);
        if (existing) {
          const spaceId = existing.id ?? existing.spaceId;
          await browser.spaces.update(spaceId, { url }, buttonProperties);
          console.log(`[Archibald] - Space ${name} mis à jour après exception`);
          return existing;
        }
      } catch (updateErr) {
        console.error(`[Archibald] - Erreur lors de la mise à jour de ${name}:`, updateErr);
      }
    } else {
      console.error(`[Archibald] - Erreur registerOrUpdateSpace (${name}):`, e);
    }
  }
}

let _spaceButtonCreated = false;
async function createSpaceButton() {
  if (_spaceButtonCreated) return;

  // Delay of 250ms to let WebApps (immediate) and Pauline/Anais (200ms) register first,
  // ensuring Archibald appears below them in the SpacesToolbar.
  await new Promise(resolve => setTimeout(resolve, 250));

  try {
    const spaceName = "Archibald";
    const defaultUrl = browser.runtime.getURL("content/archibald.html");
    const buttonProperties = {
      title: "Archibald",
      defaultIcons: {
        "16": "skin/images/archive_dark.svg",
        "32": "skin/images/archive_dark.svg",
      },
      themeIcons: [
        {
          "dark": "skin/images/archive_light.svg",
          "light": "skin/images/archive_dark.svg",
          "size": 16
        },
        {
          "dark": "skin/images/archive_light.svg",
          "light": "skin/images/archive_dark.svg",
          "size": 32
        }
      ]
    };

    await registerOrUpdateSpace(spaceName, defaultUrl, buttonProperties);
    _spaceButtonCreated = true;
    console.log(`[Archibald] - Space button initialisé avec succès`);
    try {
      browser.archibaldApi.init();
    } catch (e) {
      console.error("[Archibald] - init post-creation erreur:", e);
    }
  } catch (error) {
    console.error("[Archibald] - Error creating space button:", error);
  }
}

// background.js (loaded via manifest v3)
function archibaldInit() {
  //console.log("[Archibald] - Archibald background loaded.");
  browser.archibaldApi.init();

  browser.archibaldApi.onArchive.removeListener(messageListener);
  browser.archibaldApi.onArchive.addListener(messageListener);

  createSpaceButton();
}

// Listens for Thunderbird archive requests
function messageListener(messages) {
  console.log("[Archibald] - Background received data from implementation:", messages);
  openArchibaldWithData(messages);
}

// Lets be SURE by ANY mean that we are awake and listening
async function waitForMailTabAndRun() {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.mailTab) {
      archibaldInit();
      return;
    }
  }
  // Wait until a mail tab is created
  browser.tabs.onCreated.addListener(async (tab) => {
    if (tab.mailTab) {
      archibaldInit();
    }
  });
}
waitForMailTabAndRun();
browser.runtime.onStartup.addListener(() => archibaldInit());
browser.runtime.onInstalled.addListener(() => archibaldInit());
archibaldInit();
setInterval(() => { archibaldInit(); }, 10000);

// Opens Archibald in a tab, passing through a Thunderbird archive request
async function openArchibaldWithData(messages) {
  await browser.storage.local.set({ "thunderbirdRequest": messages });
  await browser.runtime.openOptionsPage();
  try {
    browser.runtime.sendMessage({ action: "processPendingMessages" }).catch(() => {});
  } catch (_) {}
}