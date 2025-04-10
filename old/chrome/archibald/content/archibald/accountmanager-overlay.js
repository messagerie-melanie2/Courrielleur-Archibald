ChromeUtils.import("resource://gre/modules/Services.jsm");

//memorisation temporaire des configurations d'archivage des boites (enregistrees sur le bouton OK)
//tableau de ArchibaldParamsCompte
//indices : serverkey du compte
var gConfigsArchivage;


//sauvegarde permanente de toutes les configurations du gestionnaire des comptes
//appelee depuis accountmanager-overlay.xul sur ondialogaccept
function archiSaveAllConfigs() {

  //si bouton OK depuis page am-archibald, sauve page
  if (top.frames["contentFrame"].document.location.host=="archibald") {
    ArchibaldTrace("archiSaveAllConfigs sauve page");
    top.frames["contentFrame"].onSave();
  }

  if (null==gConfigsArchivage) {
    ArchibaldTrace("archiSaveAllConfigs aucun compte a sauvegarder");
    return;
  }

  let b=false;
  for (var serverkey in gConfigsArchivage) {
    let config=gConfigsArchivage[serverkey];
    ArchibaldSauveParamsCompte(config);
    b=true;
  }


  if (b)
    Services.prefs.savePrefFile(null);
}

/* memorise configuration en cours depuis page am-archibald
* param : instance ArchibaldParamsCompte
*/
function archiMemoConfig(config) {

  if (null==gConfigsArchivage) {
    gConfigsArchivage=new Object();
  }
  
  gConfigsArchivage[config.serverkey]=config;
}

/*
* retourne configuration
* param : serverkey
*/
function archiGetConfig(serverkey) {

  //recherche dans gConfigsArchivage
  if (null!=gConfigsArchivage &&
      gConfigsArchivage[serverkey]) {
    ArchibaldTrace("archiGetConfig depuis gConfigsArchivage serverkey:"+serverkey);
    return gConfigsArchivage[serverkey];
  }

  //sinon lecture
  ArchibaldTrace("archiGetConfig lecture config serverkey:"+serverkey);
  let config=ArchibaldLitParamsCompte(serverkey);

  //memo
  archiMemoConfig(config);

  return config;
}
