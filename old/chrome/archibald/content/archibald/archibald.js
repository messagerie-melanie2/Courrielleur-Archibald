ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource:///modules/mailServices.js");


//nombre de jours pour l'archivage
//archive les message de plus de archi_jours jours
const archi_jours=90;

//nom de la racine des dossiers d'archivage dans le profil utilisateur
const RACINE_ARCHIVES="Archives";

//prefixe du libelle du dossier d'archive automatique d'un user
const PREFIX_ARCHIVES="Archives de "


//parametres d'archivage d'un compte
function ArchibaldParamsCompte(){};

ArchibaldParamsCompte.prototype={

  //true: archivage actif
  etat : false,
  //nombre de jours pour l'archivage (messages de plus de n jours)
  jours : archi_jours,
  //dossier d'archivage (pref "mail.server."+serverkey+".archibald.dossier")
  //=> mail.server.server<n>.hostname du dossier local
  dossier : "",
  //pour mode debug, copie les messages au lieu de les transferer dans le dossier d'archive
  modecopie : false,
  //pref "mail.server."+server<n> de la boite
  serverkey : "",
  //imap|mailbox+"://"+<uid>+"@"+<hostname>;
  serverId : "",
  //libelle du compte (boite)
  libelle : "",
  //identifiant de boite
  uid : "",
  //equivalent tb "mail.identity."+cle+".archive_granularity"
  //valeur 0 par defaut pour ne pas comprommettre l'existant archibald
  archiveGranularity : 0,
  //equivalent tb "mail.identity."+cle+".archive_keep_folder_structure"
  archiveKeepFolderStructure : true,

  //determine/calcul le libelle du dossier pour une boite (mode auto)
  LibelleDossierAuto: function() {

    let  lib=PREFIX_ARCHIVES+this.libelle;
    //suppression description ou service
    //suppression partie droite ' (' ou ' -'
    lib=lib.replace(/ \x28.*| - .*/,"");
    return lib;
  },

  //retourne true si le dossier est valide
  isDossierValide: function() {

    if (null==this.dossier ||
        ""==this.dossier) {
      return false;
    }

    let  srv=ArchiGetSrvDossier(this.dossier);

    if (null==srv)
      return false;

    //verifications repertoire
    let  dir=srv.localPath;
    if (! dir||
        !dir.exists()) {
      if (dir){
        ArchibaldTrace("isDossierValide repertoire inexistant:"+dir.path);
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Dossier d'archivage (repertoire) inexistant", dir.path);
      } else {
        ArchibaldTrace("isDossierValide repertoire inexistant");
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Dossier d'archivage (repertoire) inexistant");
      }
      return false;
    }
    if (!dir.isDirectory()){
      ArchibaldTrace("isDossierValide n'est pas un repertoire:"+dir.path);
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Le dossier d'archivage n'est pas un repertoire", dir.path);
      return false;
    }
    if (!dir.isWritable()){
      ArchibaldTrace("isDossierValide isWritable false:"+dir.path);
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Le dossier d'archivage n'est pas en ecriture", dir.path);
      return false;
    }

    return true;
  },

  //retourne true dans le cas d'une bali
  isBali: function() {
    if("nobody"!=this.uid && !this.isBalp())
      return true;
    return false;
  },
  
  //retourne true si balp
  isBalp: function() {
    if (-1!=this.uid.indexOf(".-."))
      return true;
    return false;
  },
  
  //retourne true si dossier
  isDossier: function() {
    if("nobody"==this.uid)
      return true;
    return false;
  }
}

//retourne true dans le cas d'une bali
//se base sur .-. et != de nobody
function uidIsBali(uid){
  
  if ("nobody"==uid)
    return false;
  if (-1==uid.indexOf(".-."))
    return true;
  return false;
}

//retourne true si balp
function uidIsBalp(uid){
  
  if (-1!=uid.indexOf(".-."))
    return true;
  return false;
}

//retourne true si uid de dossier
function uidIsDossier(uid){
  
  if ("nobody"==uid)
    return true;
  return false;
}
  

//lecture parametres d'archivage d'un compte
// serverkey : identifiant serveur
// v5 : complementes initialisations si etat false
//retourne instance ArchibaldParamsCompte
function ArchibaldLitParamsCompte(serverkey){

  ArchibaldTrace("ArchibaldLitParamsCompte serverkey="+serverkey);

  //lecture preferences
  let  params=new ArchibaldParamsCompte();
  params.serverkey=serverkey;

  let  srv=MailServices.accounts.getIncomingServer(serverkey);
  params.uid=srv.username;
  params.libelle=srv.prettyName;
  ArchibaldTrace("ArchibaldLitParamsCompte libelle:"+params.libelle);

  if ("imap"==srv.type) {
    params.serverId="imap://"+params.uid+"@"+srv.hostName;
  } else {
    params.serverId="mailbox://"+params.uid+"@"+srv.hostName;
  }

  let  prefix="mail.server."+serverkey;
  if (!Services.prefs.prefHasUserValue(prefix+".archibald.etat")){
    //pas configuré pour l'archivage -> valeurs par defaut avec serverkey
    ArchibaldTrace("ArchibaldLitParamsCompte non configure pour l'archivage");
    return params;
  }
  params.etat=Services.prefs.getBoolPref(prefix+".archibald.etat");
  if (!params.etat)
    ArchibaldTrace("ArchibaldLitParamsCompte archivage desactive");
  if (Services.prefs.prefHasUserValue(prefix+".archibald.jours")){
    params.jours=Services.prefs.getIntPref(prefix+".archibald.jours");
  }
  if (Services.prefs.prefHasUserValue(prefix+".archibald.dossier")){
    params.dossier=Services.prefs.getCharPref(prefix+".archibald.dossier");
    if (!params.isDossierValide()){
      params.etat=false;
      //ne pas effacer la valeur pour eviter ecrasement par configuration automatique
      Services.prefs.setBoolPref(prefix+".archibald.etat",false);
    }
  }
  
  params.modecopie=Services.prefs.getBoolPref("archibald.modecopie");

  if ("imap"==srv.type || "pop3"==srv.type) {

    let  ident=MailServices.accounts.getFirstIdentityForServer(srv);
    let  prefident="mail.identity."+ident.key;

    //"mail.identity."+cle+".archive_granularity"
    if (Services.prefs.prefHasUserValue(prefident+".archive_granularity")){
      params.archiveGranularity=Services.prefs.getIntPref(prefident+".archive_granularity");
    }

    //"mail.identity."+cle+".archive_keep_folder_structure"
    if (Services.prefs.prefHasUserValue(prefident+".archive_keep_folder_structure")){
      params.archiveKeepFolderStructure=Services.prefs.getBoolPref(prefident+".archive_keep_folder_structure");
    }

  } else {

    //dossiers locaux
    //preferences au niveau du serveur

    //"mail.server."+<serverkey>."archive_granularity"
    if (Services.prefs.prefHasUserValue(prefix+".archive_granularity")){
      params.archiveGranularity=Services.prefs.getIntPref(prefix+".archive_granularity");
    }

    //"mail.server."+<serverkey>."archive_keep_folder_structure"
    if (Services.prefs.prefHasUserValue(prefix+".archive_keep_folder_structure")){
      params.archiveKeepFolderStructure=Services.prefs.getBoolPref(prefix+".archive_keep_folder_structure");
    }
  }

  return params;
}

//version ArchibaldLitParamsCompte avec identifiant utilisateur en parametre
function ArchibaldLitParamsUid(uid){

  const nb=MailServices.accounts.accounts.length;

  for (var  i=0;i<nb;i++){

    let  compte=MailServices.accounts.accounts.queryElementAt(i,Components.interfaces.nsIMsgAccount);
    if (null==compte||null==compte.incomingServer)
      continue;

    let  srv=compte.incomingServer;
    let  type=srv.type;

    if (("pop3"==type || "imap"==type) &&
        srv.username==uid) {

      let  config=ArchibaldLitParamsCompte(srv.key);

      return config;
    }
  }

  return null;
}

//sauvegarde les parametres d'archivage d'un compte
//params : instance ArchibaldParamsCompte
//granul : si true, sauvegarde la granularite si params.etat à true.
function ArchibaldSauveParamsCompte(params, granul){

  if (null==params) {
    ArchibaldTrace("ArchibaldSauveParamsCompte null==params");
    return;
  }

  ArchibaldTrace("ArchibaldSauveParamsCompte sauvegarde des preferences");

  let  prefix="mail.server."+params.serverkey+".archibald.";

  Services.prefs.setBoolPref(prefix+"etat", params.etat);

  if (params.etat) {

    Services.prefs.setIntPref(prefix+"jours", params.jours);
    Services.prefs.setCharPref(prefix+"dossier",params.dossier);
    Services.prefs.setBoolPref(prefix+"etat", true);

    if (granul) {
      ArchibaldSauveGranul(params);
    }

  } else {

    Services.prefs.setIntPref(prefix+"jours", archi_jours);
    //ne pas effacer la valeur pour eviter ecrasement par configuration automatique
    Services.prefs.setBoolPref(prefix+"etat", false);
  }
}

function ArchibaldSauveGranul(params){

  ArchibaldTrace("ArchibaldSauveGranul sauvegarde la granularite");
  let  srv=MailServices.accounts.getIncomingServer(params.serverkey);

  if ("imap"==srv.type || "pop3"==srv.type) {

    let  ident=MailServices.accounts.getFirstIdentityForServer(srv);
    let  prefident="mail.identity."+ident.key;
    Services.prefs.setIntPref(prefident+".archive_granularity", params.archiveGranularity);
    Services.prefs.setBoolPref(prefident+".archive_keep_folder_structure", params.archiveKeepFolderStructure);

  } else {

    //dossiers locaux
    //preferences au niveau du serveur
    Services.prefs.setIntPref("mail.server."+params.serverkey+".archive_granularity", params.archiveGranularity);
    Services.prefs.setBoolPref("mail.server."+params.serverkey+".archive_keep_folder_structure", params.archiveKeepFolderStructure);
  }
}


/*
*	recherche un serveur de dossier local dans le gestionnaire des comptes de thunderbird
*
*	@param hostname	nom du serveur dossier local (hostName)
*	@return instance  nsIMsgIncomingServer si succès, null si absent
*/
function ArchiGetSrvDossier(hostname){

  let  serveurs=MailServices.accounts.allServers;
  for (var  i=0;i<serveurs.length;i++){
    let  srv=serveurs.queryElementAt(i, Components.interfaces.nsIMsgIncomingServer);
    if (srv.hostName==hostname &&
        "none"==srv.type &&
        "nobody"==srv.username){
      return srv;
    }
  }
  return null;
}



/*
*	Retourne la liste des comptes configurables pour l'archivage
*
* v3 : tableau de ArchibaldParamsCompte
* v5 : liste toutes les boites pacome, meme non configuree => mode auto
*/
function ArchiListeComptes(){

  let  listecomptes=Array();

  const nb=MailServices.accounts.accounts.length;

  for (var  i=0;i<nb;i++){

    let  compte=MailServices.accounts.accounts.queryElementAt(i,Components.interfaces.nsIMsgAccount);
    if (null==compte ||
        null==compte.incomingServer)
      continue;

    let  srv=compte.incomingServer;
    let  type=srv.type;

    if ("pop3"==type || "imap"==type ||
        ("none"==type && "nobody"==srv.username)){

      let  config=ArchibaldLitParamsCompte(srv.key);
      if (null==config) {
        ArchibaldTrace("ArchiListeComptes null==config!");
        continue;
      }

      ArchibaldTrace("ArchiListeComptes compte:"+config.uid+" - archivage:"+(config.etat?"true":"false"));

      listecomptes.push(config);
    }
  }
  ArchibaldTrace("ArchiListeComptes nombre="+listecomptes.length);

  return listecomptes;
}

/*
*	retourne true si le client est connecté (online)
*/
function ArchibaldIsOnline()
{
  return !Services.io.offline;
}



/*
* Remplacement de la fonction original Thunderbird 'MsgArchiveSelectedMessages'
* (fichier messenger.jar\content\messenger\mailWindowOverlay.js)
* v5 pour les bali declencher l'archivage meme si non configuree => mode auto
*/
function archibaldArchiveSelectedMessages(event) {

  ArchibaldTrace("archibaldArchiveSelectedMessages");

  let  msgs=gFolderDisplay.selectedMessages;

  //archivage archibald?
  let  hdr=msgs[0];
  let  srv=hdr.folder.server;

  if ("pop3"==srv.type ||
      "imap"==srv.type) {

    let  config=ArchibaldLitParamsCompte(srv.key);

    //configuration automatique bali necessaire?
    if (null!=config &&
        config.isBali() &&
        (!config.etat ||
          !config.isDossierValide())) {
      config=archiAutoConfBali(config.uid);
    }

    if (null!=config &&
        config.etat &&
        config.isDossierValide() ) {
      ArchibaldTrace("archibaldArchiveSelectedMessages archivage uid:"+config.uid);

      //archivage
      let  arch=new ArchibaldArchive(notifArchivageMsg);
      gFolderDisplay.hintMassMoveStarting();
      arch.ArchivageMessages(config, msgs);

      return;
    }
  }

  ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Commande d'archivage pour un compte non configure", srv.prettyName);
  ArchibaldAfficheMsgId("archibaldNoConfig");
}

let notifArchivageMsg={
  OnArchivageEnd: function() {
    ArchibaldTrace("notifArchivageMsg OnArchivageEnd");
    gFolderDisplay.hintMassMoveCompleted();
  }
}


/**
* retourne instance nsIFile du repertoire d'archive automatique de boite
*/
function getDirDossierBali(uid) {

  //RACINE_ARCHIVES
  let  dir=ArchibaldGetProfD();
  if (null==dir) {
    ArchibaldTrace("getDirDossierBali echec lecture profil");
    return 0;
  }
  dir.append(RACINE_ARCHIVES);
  dir.append(uid);
  ArchibaldTrace("getDirDossierBali:"+dir.path);
  return dir;
}

/*
* Cree si n'existe pas le dossier d'archivage d'une boite (repertoire+compte)
* ex: C:\Documents and Settings\<user>\Application Data\Thunderbird\Profiles\xxx.default\RACINE_ARCHIVES\uid pour les archives d'une bali uid
* prend uid en parametre
* retourne 1 si OK, 0 sinon
*/
function creeDossierArchive(uid, libelle) {

  if (null==uid || ""==uid) {
    ArchibaldTrace("creeDossierArchive erreur uid");
    return 0;
  }
  if (null==libelle || ""==libelle) {
    ArchibaldTrace("creeDossierArchive erreur libelle");
    return 0;
  }

  let  dir=getDirDossierBali(uid);

  //creation repertoire
  if (!dir.exists()) {
    ArchibaldTrace("creeDossierArchive creation du dossier '"+dir.path+"'");
    try {
      dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0755);
    } catch(ex) {
      ArchibaldTrace("creeDossierArchive exception:"+ex);
      return 0;
    }
  }

  //verifier que le compte dossier local n'existe pas deja (meme uid - dossier different)
  let  srv=ArchiGetSrvDossier(uid);
  if (null!=srv) {
    ArchibaldTrace("creeDossierArchive le compte dossier local existe deja");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Configuration automatique - le compte dossier local existe deja. uid:"+uid);
    //dossier ok?
    if (srv.localPath.path==dir.path) {
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Configuration automatique - dossier local existant avec chemin non conforme");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Configuration automatique - annulation configuration");
      return 0;
    }
  }
  //creation compte dossier local
  //si creeDossierArchive est appelee, le compte n'est pas sense exister, sauf si suppression
  if (null==srv)
    srv=MailServices.accounts.createIncomingServer("nobody",  uid, "none");

  srv.localPath=dir;
  srv.prettyName=libelle;

  let  account=MailServices.accounts.createAccount();
  account.incomingServer=srv;

  //spamLevel "mail.server.default.spamLevel"
  let  prefBranch=Services.prefs.getBranch("mail.server.");
  let  spamLevel=prefBranch.getIntPref("default.spamLevel");
  let  pref=srv.key+".spamLevel";
  prefBranch.setIntPref(pref, spamLevel);
  Services.prefs.savePrefFile(null);

  return 1;
}

/*
* Recherche dossier bali existant à partir de l'uid
* retourne instance nsIMsgIncomingServer si existe, sinon null
*/
function getSrvDossierBali(uid) {

  let  dir=getDirDossierBali(uid);

  let  serveurs=MailServices.accounts.allServers;
  for (var  i=0;i<serveurs.length;i++)
  {
    let  srv=serveurs.queryElementAt(i, Components.interfaces.nsIMsgIncomingServer);
    ArchibaldTrace("getSrvDossierBali srv.directory:"+srv.localPath.path);
    if ("none"==srv.type &&
        srv.localPath.path==dir.path) {
      ArchibaldTrace("getSrvDossierBali dossier existe");
      return srv;
    }
  }
  return null;
}


/*
* fonction generique d'appel de la boite de confirmation d'archivage
* parametres:
* bal: libelle boite
* jours: nombre de jours pour l'archivage
* uid : identifiant du compte
* dossier: libelle dossier (optionnel)
* sousdossiers : si true archive les sous-dossiers (optionnel)
* retour:
* res: 1 si bouton OK
* jours: nombre de jours
* sousdossiers : si true archive les sous-dossiers
*/
function confirmArchivage(bal, jours, uid, dossier, sousdossiers) {

  let  args=new Object();
  args.bal=bal;
  args.jours=jours;
  args.uid=uid;

  if (dossier) {
    args.dossier=dossier;
    if (null!=sousdossiers)
      args.sousdossiers=sousdossiers;
  }

  if (Services.prefs.getBoolPref("archibald.dlgconfirm")) {

    //version avec choix de la periode
    window.openDialog("chrome://archibald/content/archiDlgConfirm.xul","","chrome,modal,centerscreen,titlebar",args);

  } else {

    //version standard (promptservice)
    let  msg;
    let  checkValue={value:false};
    let  promptService=Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService);

    //boite ou dossier?
    if (!dossier) {

      //confirmation de l'archivage de boite
      msg=ArchibaldMessageFromId("archibaldConfirm1");
      msg+="\n"+bal+"?";

    } else {

      //confirmation archivage de dossier
      msg=ArchibaldFormatStringFromName("archibaldConfirmDos", [dossier, bal], 2);

      args.dossier=dossier;
    }

    let  res=promptService.confirmEx(window, ArchibaldMessageFromId("archibaldPromptTitle"), msg,
                                    promptService.STD_YES_NO_BUTTONS,
                                    "","","","",checkValue);
    if (res)
      args.res=0;
    else
      args.res=1;
  }
  ArchibaldTrace("confirmArchivage retour args.jours:"+args.jours);
  return args;
}


/*
* fonction de configuration automatique de l'archivage pour une bali a partir de l'uid
* cree le dossier d'archivage si necessaire
* si on dossier est configure (".archibald.dossier") => pas d'écrasement
* si dossier non valide => return null
* retourne la configuration ArchibaldParamsCompte si ok
* sinon null
*/
function archiAutoConfBali(uid) {

  ArchibaldTrace("archiAutoConfBali uid:"+uid);
  ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Demarrage configuration automatique pour uid:"+uid);

  let  config=ArchibaldLitParamsUid(uid);
  if (null==config) {
    //erreur de compte
    ArchibaldTrace("archiAutoConfBali Echec de configuration automatique pour uid:'"+uid+"' - erreur de lecture de compte");
    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Echec de configuration automatique pour uid:'"+uid+"' - erreur de lecture de compte");
    return null;
  }

  //configuration du dossier
  if (!config.isDossierValide()) {

    ArchibaldTrace("archiAutoConfBali recherche dossier");
    let  srv=getSrvDossierBali(uid);
    if (null!=srv) {
      ArchibaldTrace("archiAutoConfBali dossier existe");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Configuration automatique - le dossier existe", srv.hostName);
    } else {
      //creation dossier
      let libdossier=config.LibelleDossierAuto();
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Configuration automatique - creation du dossier d'archivage");
      let  res=creeDossierArchive(uid, libdossier);

      if (0==res) {
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "echec creation automatique du dossier pour uid:'"+uid+"'");
        promptService.alert(window, ArchibaldMessageFromId("archibaldDossierArchive"), ArchibaldMessageFromId("archibaldDossierEchec"));
        return null;
      }

      srv=getSrvDossierBali(uid);
    }
    config.dossier=srv.hostName;
  }
  ArchibaldTrace("archiAutoConfBali dossier:"+config.dossier);

  //granularity annee/dossier
  config.archiveGranularity=1;
  config.archiveKeepFolderStructure=true;

  //activation
  config.etat=true;

  //sauvegarde
  ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Configuration automatique - enregistrement de la configuration");
  ArchibaldSauveParamsCompte(config, true);

  //relecture
  config=ArchibaldLitParamsUid(uid);

  return config;
}
