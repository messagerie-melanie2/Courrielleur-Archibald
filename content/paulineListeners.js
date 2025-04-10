const paulineUrl = 'https://annuaire-preprod.e2.rie.gouv.fr/';

// Sets iframe url for Pauline
function updateIframeSrc()
{
  let cacheBustedUrl = paulineUrl + '?nocache=' + new Date().getTime();
  let defaultPauline = cacheBustedUrl;
  let composePauline = cacheBustedUrl+"&source=courrielleur";

  // checking for parameter "compose=true"
  let compose = getQueryParam("compose") === "true";

  // Setting iframe url
  document.getElementById("pauline-iframe").src = compose ? composePauline : defaultPauline;
}
updateIframeSrc();

// Retrieve a get parameter
function getQueryParam(param) {
  let urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(param);
}

// Listen for messages from the iframe
window.addEventListener('message', async function(event) {
    handlePaulineMessage(event);
});

// Handle message from external Pauline website
async function handlePaulineMessage(event)
{
  // Ensure the message is from the correct origin
  /*if (event.origin !== paulineUrl) {
      showNotification("Message inconnu", "Message reçu de la source non reconnue: "+event.origin);
      return;
  }*/

  // Check the action and perform the desired script
  if (event.data.action === 'addRecipient') {
      console.log("addRecipient");
      showNotification("Ajout de destinataire", event.data.data);
      await addTextToRecipientField(event.data.data);
      return;
  }
}

document.addEventListener("DOMContentLoaded", async () =>
{
});