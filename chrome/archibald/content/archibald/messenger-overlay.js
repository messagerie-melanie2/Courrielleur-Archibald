ChromeUtils.import("resource:///modules/mailServices.js");

window.addEventListener("load",initArchibald,false);

/*
* initialisations au démarrage
*
*/
function initArchibald(){

  ArchibaldTrace("initArchibald");

  //menu contextuel
  let  menu=document.getElementById("folderPaneContext");
  menu.addEventListener("popupshowing", menuContext, false);

  initBtArchiveMulti();
}

/*
* Modification dynamique du bouton hdrArchiveButton de multimessage
*/
function initBtArchiveMulti() {

  let  multi=document.getElementById("multimessage");
  let  bt=multi.contentDocument.getElementById("hdrArchiveButton");
  bt.setAttribute("onclick", "if (event.button == 0) window.top.archibaldArchiveSelectedMessages(null);");
}

/*
* événement onpopupshowing du bouton d'archivage 'archibald-btarchive'
*
*/
function btArchiShowing(event){

  ArchibaldTrace("btArchiShowing");

  supprimeMenus();

  let  configs=ArchiListeComptes();
  if (null==configs)
    return;
  
  const nb=configs.length;
  for (var  n=0;n<nb;n++) {

    if (configs[n].etat ||
        configs[n].isBali()) {
      ArchibaldTrace("btArchiShowing ajouteMenuCompte:"+configs[n].uid);
      ajouteMenuCompte(event.target, configs[n].libelle, configs[n].serverkey, configs[n].uid);
    }
  }

  return true;
}


/*
* ajoute un élément de menu pour archiver un compte spécifié
*
*/
function ajouteMenuCompte(menupopup, libelle, serverkey, uid){

  ArchibaldTrace("ajouteMenuCompte serverkey:"+serverkey);

  let  elem=document.getElementById(serverkey);
  if (elem)
    return;
  let  item=document.createElement("menuitem");
  item.setAttribute("label",libelle);
  item.setAttribute("id", serverkey);
  item.setAttribute("value", uid);

  menupopup.appendChild(item);
}


/*
* supprime tous les menus d'archivage de compte
*
*/
function supprimeMenus(){

  let  menupopup=document.getElementById("archibald-menupopup");
  let  nb=menupopup.childNodes.length;
  while (nb){
    let  elem=menupopup.childNodes[nb-1];
    menupopup.removeChild(elem);
    nb--;
  }
}


/*
* événement oncommand du bouton d'archivage 'archibald-btarchive'
*
*/
function btArchive(event){

  ArchibaldTrace("btArchive");

  //si client offline -> message utilisateur pas d'archivage
  if (!ArchibaldIsOnline()){
    ArchibaldAfficheMsgId("archibaldOffline");
    return;
  }

  //il faut déterminer s'il y a au moins un compte à archiver
  let  configs=ArchiListeComptes();
  if (null==configs ||
      0==configs.length) {
    ArchibaldAfficheMsgId("archibaldPasdeCompte");
    return;
  }

  let  id=event.target.id;
  let  uid="";
  let  serverkey="";

  if (null!=id &&
      "archibald-btarchive"!=id){
    serverkey=id;
    uid=event.target.value;
  }

  if (""==uid) {
    //bouton archiver clique sans boite selectionnnee
    //=> prendre boite courante ou bali principale
    let  dossier=GetFirstSelectedMsgFolder();
    if (null!=dossier &&
        ("pop3"==dossier.server.type ||
        "imap"==dossier.server.type) ) {
      let  srvuid=dossier.server.username;
      if (uidIsBali(srvuid)) {
        uid=srvuid;
        serverkey=dossier.server.key;
      } else {
        //balp : si configuree prendre uid
        //idem pour dossier
        let  conf=ArchibaldLitParamsCompte(dossier.server.key);
        if (conf.etat &&
            conf.isDossierValide()) {
          uid=srvuid;
          serverkey=dossier.server.key;
        }
      }
      ArchibaldTrace("btArchive boite selectionnee uid:"+uid);
    }
    if (""==uid) {
      //rechercher 1ere bali
      const nb=configs.length;
      for (var  n=0;n<nb;n++) {
        if (configs[n].isBali()) {
          uid=configs[n].uid;
          serverkey=configs[n].serverkey;
          ArchibaldTrace("btArchive selection 1ere boite bali uid:"+uid);
          break;
        }
      }
    }
  }

  //pas de compte a archiver
  if (""==uid) {
    ArchibaldAfficheMsgId("archibaldPasdeCompte");
    return;
  }
  //configuration
  let  config=null
  for (var  n=0;n<configs.length;n++) {
    if (serverkey==configs[n].serverkey) {
      config=configs[n];
    }
  }

  ArchibaldTrace("btArchive uid a archiver:"+uid);

  //confirmation de l'archivage
  let  args=confirmArchivage(config.libelle, config.jours, config.uid);

  if (1!=args.res) {
    ArchibaldTrace("btArchive non confirmation");
    return;
  }
  ArchibaldTrace("btArchive confirmation jours:"+args.jours);
  config.jours=args.jours;

  //verifier compte(s) connectes
  let  res=TestConnexionCompte(uid);
  if (!res) {
    ArchibaldAfficheMsgId("archibaldErrAuth");
    return;
  }

  let  params={config:config};

  if (gDBView) {
    try{
      gFolderDisplay.hintMassMoveStarting();
    } catch(ex){}
  }

  window.openDialog("chrome://archibald/content/archibalddlg.xul","","chrome,modal,centerscreen,titlebar,resizable", params);

  if (gDBView) {
    try{
      gFolderDisplay.hintMassMoveCompleted();
    } catch(ex){}
  }
}


/*
* contrôle l'affichage du menu contextuel d'archivage dans l'arborescence
* Implémentation : n'est affiché que sur les éléments des comptes (pas sur les dossiers)
* Grise pour les comptes non paramétrés ou non gérés
* grise pour les dossiers virtuels
* v5 : commande active pour les bali non configurees => mode auto
*/
function menuContext(event){

  ArchibaldTrace("menuContext");

  let  dossier=GetFirstSelectedMsgFolder();

  let  actif=false;

  if (dossier) {
    if (!dossier.getFlag(Components.interfaces.nsMsgFolderFlags.Virtual)) {
      let  serverkey=dossier.server.key;
      ArchibaldTrace("menuContext serverkey:"+serverkey);
      let  pref="mail.server."+serverkey+".archibald.";
      let  prefService=Components.classes["@mozilla.org/preferences-service;1"].getService();
      prefService=prefService.QueryInterface(Components.interfaces.nsIPrefService);
      let  nsPrefBranch=prefService.getBranch(pref);
      let  uid=dossier.server.username;

      if (uidIsBali(uid) ||
          (nsPrefBranch.prefHasUserValue("etat")&&
          nsPrefBranch.getBoolPref("etat"))){
        actif=true;
      }
    } else {
      ArchibaldTrace("menuContext dossier virtuel:"+dossier.URI);
    }
  }

  let  menu=document.getElementById("archibald.context");
  if (null==dossier ||
      ("pop3"!=dossier.server.type &&
      "imap"!=dossier.server.type && 
      "none"!=dossier.server.type) ) {
    menu.setAttribute("hidden",true);
    return false;
  }
  menu.setAttribute("hidden",false);

  if (actif) {
    menu.removeAttribute("disabled");
  } else {
    menu.setAttribute("disabled",true);
  }

  return false;
}

/*
* archivage à partir du menu contextuel
*
*/
function menuArchive(){

  ArchibaldTrace("menuArchive");

  //si client offline -> message utilisateur pas d'archivage
  if (!ArchibaldIsOnline()){
    ArchibaldAfficheMsgId("archibaldOffline");
    return;
  }

  let  dossier=GetFirstSelectedMsgFolder();

  if (null==dossier) {
    ArchibaldTrace("menuArchive null==dossier");
    return;
  }
  ArchibaldTrace("menuArchive GetFirstSelectedMsgFolder :"+dossier.URI);

  let  configs=ArchiListeComptes();
  if (null==configs || 0==configs.length) {
    ArchibaldAfficheMsgId("archibaldPasdeCompte");
    return;
  }

  let  config=null;
  let  libdossier=(!dossier.isServer) ? dossier.name : null;

  const serverkey=dossier.server.key;
  ArchibaldTrace("menuArchive serverkey:"+serverkey);

  const nb=configs.length;
  for (var  n=0;n<nb;n++) {
    if (serverkey==configs[n].serverkey) {
      config=configs[n];
      break;
    }
  }

  if (null==config) {
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Erreur commande contextuelle - pas de configuration");
    return;
  }

  //confirmation de l'archivage
  let  args=confirmArchivage(config.libelle, config.jours, config.uid, libdossier);

  if (1!=args.res) {
    ArchibaldTrace("btArchive non confirmation");
    return;
  }
  ArchibaldTrace("btArchive confirmation jours:"+args.jours);
  config.jours=args.jours;

  //verifier compte connecte
  let  res=TestConnexionCompte(config.uid);
  if (!res) {
    ArchibaldAfficheMsgId("archibaldErrAuth");
    return;
  }

  let  params={config:config};
  if (!dossier.isServer) {
    //pas le dossier du compte => archivage d'un dossier
    params.dossier=dossier;
    //option sous-dossiers
    params.sousdossiers=args.sousdossiers;
  }

  if (dossier.isServer)
    ArchibaldTrace("menuArchive appel boite archivage pour uid:"+params.config.uid);
  else
    ArchibaldTrace("menuArchive appel boite archivage pour dossier:'"+dossier.name+"' - uid:"+params.config.uid);

  if (gDBView) {
    try{
      gFolderDisplay.hintMassMoveStarting();
    } catch(ex){}
  }

  window.openDialog("chrome://archibald/content/archibalddlg.xul","","chrome,modal,centerscreen,titlebar,resizable", params);

  if (gDBView) {
    try{
      gFolderDisplay.hintMassMoveCompleted();
    } catch(ex){}
  }
}

/*
* Test et force la connexion du compte de messagerie -> authentification
*
* Si uid vide -> teste tous les comptes configures avec archibald
* v5 : uid requis
*/
function TestConnexionCompte(uid) {

  ArchibaldTrace("TestConnexionCompte uid="+uid);

  if (null==uid || ""==uid) {
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "TestConnexionCompte uid non renseigne");
    return false;
  }

  const nb=MailServices.accounts.accounts.length;
  let  config=null;
  ArchibaldTrace("TestConnexionCompte nb="+nb);

  for (var  i=0;i<nb;i++){

    let  compte=MailServices.accounts.accounts.queryElementAt(i,Components.interfaces.nsIMsgAccount);
    if (null==compte ||
        null==compte.incomingServer)
      continue;

    let  srv=compte.incomingServer;
    let  type=srv.type;
    config=null;

    if (("pop3"==type || "imap"==type) &&
        (srv.username==uid) ){

      ArchibaldTrace("TestConnexionCompte srv.username==uid");

      if (null==srv.password || ""==srv.password ) {

        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Demande d'authentification pour le compte avec uid=", uid);

        let  str=srv.getPasswordWithUI("", "", msgWindow);

        if (null==str || ""==str) {
          return false;
        }
      }

      return true;
    }
  }

  return true;
}
