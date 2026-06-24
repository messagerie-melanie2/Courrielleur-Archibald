let _spaceButtonCreated = false;
async function createSpaceButton() {
  if (_spaceButtonCreated) return;

  // Delay of 400ms to let WebApps (immediate) and Pauline/Anais (200ms) register first,
  // ensuring Archibald appears below them in the SpacesToolbar.
  await new Promise(resolve => setTimeout(resolve, 250));

  try {
    const spaceName = "Archibald";
    const defaultUrl = browser.runtime.getURL("content/archibald.html");
    const buttonProperties = {
      title: "Archibald",
      themeIcons: [
        {
          "light": "skin/images/archive_light.svg",
          "dark": "skin/images/archive_dark.svg",
          "size": 18
        },
        {
          "light": "skin/images/archive_light.svg",
          "dark": "skin/images/archive_dark.svg",
          "size": 32
        }
      ]
    };

    const space = await browser.spaces.create(spaceName, defaultUrl, buttonProperties);
    _spaceButtonCreated = true;
    console.log(`[Archibald] - Space button created with space ID: ${space.id}`);
  } catch (error) {
    if (error.message && error.message.includes("already")) {
      _spaceButtonCreated = true;
      console.log("[Archibald] - Space button already exists.");
    } else {
      console.error("[Archibald] - Error creating space button:", error);
    }
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
}